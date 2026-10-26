//! In-memory sliding-window limits for logins and pairing starts.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr};
use std::time::{Duration, Instant};

pub const LOGIN_FAILURES_PER_IP: usize = 5;
pub const LOGIN_IP_WINDOW: Duration = Duration::from_secs(15 * 60);
pub const LOGIN_FAILURES_GLOBAL: usize = 100;
pub const LOGIN_GLOBAL_WINDOW: Duration = Duration::from_secs(3600);
pub const PAIR_STARTS_PER_IP: usize = 5;
pub const PAIR_START_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Password checks (argon2id, about 19 MiB each) that may run at once.
pub const MAX_PASSWORD_CHECKS: usize = 2;
/// How long a login waits for a password check to free up before it gets 429.
pub const PASSWORD_CHECK_QUEUE: Duration = Duration::from_secs(5);
/// Clients a window tracks at most; past that, new clients are refused until tracked ones expire.
pub const MAX_KEYS: usize = 10_000;
/// A full window looks for expired clients at most this often.
const MIN_SWEEP_INTERVAL: Duration = Duration::from_secs(1);

/// Counts events per key over a sliding window, for at most `max_keys` keys.
///
/// Calls prune only their own key. The whole map is swept at most once per period, and when it is full at most once
/// per `MIN_SWEEP_INTERVAL` and only once some key has expired.
pub struct SlidingWindow {
    limit: usize,
    period: Duration,
    max_keys: usize,
    events: HashMap<String, VecDeque<Instant>>,
    last_sweep: Option<Instant>,
    /// The earliest time a key could become empty, as of the last sweep.
    next_expiry: Option<Instant>,
    #[cfg(test)]
    sweeps: usize,
}

impl SlidingWindow {
    pub fn new(limit: usize, period: Duration) -> SlidingWindow {
        SlidingWindow::with_max_keys(limit, period, MAX_KEYS)
    }

    pub fn with_max_keys(limit: usize, period: Duration, max_keys: usize) -> SlidingWindow {
        SlidingWindow {
            limit,
            period,
            max_keys,
            events: HashMap::new(),
            last_sweep: None,
            next_expiry: None,
            #[cfg(test)]
            sweeps: 0,
        }
    }

    /// How many keys are tracked.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Drops `key`'s events that left the window, and the key when none are left.
    fn prune_key(&mut self, key: &str, now: Instant) {
        let period = self.period;
        if let Some(events) = self.events.get_mut(key) {
            while events.front().is_some_and(|t| *t + period <= now) {
                events.pop_front();
            }
            if events.is_empty() {
                self.events.remove(key);
            }
        }
    }

    fn sweep(&mut self, now: Instant) {
        let period = self.period;
        self.events.retain(|_, events| {
            while events.front().is_some_and(|t| *t + period <= now) {
                events.pop_front();
            }
            !events.is_empty()
        });
        self.next_expiry = self.events.values().filter_map(|events| events.back()).min().map(|t| *t + period);
        self.last_sweep = Some(now);
        #[cfg(test)]
        {
            self.sweeps += 1;
        }
    }

    fn since_sweep_at_least(&self, now: Instant, interval: Duration) -> bool {
        self.last_sweep.is_none_or(|t| now >= t + interval)
    }

    /// How long until `key` may have another event, or `None` when it may now. Does not check room for a new key.
    pub fn retry_after(&mut self, key: &str, now: Instant) -> Option<Duration> {
        self.prune_key(key, now);
        let events = self.events.get(key)?;
        (events.len() >= self.limit).then(|| events[events.len() - self.limit] + self.period - now)
    }

    /// Records an event for `key`, or returns how long to wait when `key` is at its limit or no new key fits.
    pub fn try_record(&mut self, key: &str, now: Instant) -> Result<(), Duration> {
        if let Some(wait) = self.retry_after(key, now) {
            return Err(wait);
        }
        let full = !self.events.contains_key(key) && self.events.len() >= self.max_keys;
        let swept_full = full
            && self.since_sweep_at_least(now, MIN_SWEEP_INTERVAL)
            && self.next_expiry.is_none_or(|t| now >= t);
        if swept_full || self.since_sweep_at_least(now, self.period) {
            self.sweep(now);
        }
        if !self.events.contains_key(key) && self.events.len() >= self.max_keys {
            let sweep_allowed = self.last_sweep.map_or(now, |t| t + MIN_SWEEP_INTERVAL);
            let room_at = self.next_expiry.map_or(sweep_allowed, |t| t.max(sweep_allowed));
            return Err(room_at.saturating_duration_since(now));
        }
        self.events.entry(key.to_owned()).or_default().push_back(now);
        Ok(())
    }

    /// Takes back the event recorded for `key` at `at`.
    pub fn forget(&mut self, key: &str, at: Instant) {
        if let Some(events) = self.events.get_mut(key) {
            if let Some(i) = events.iter().rposition(|t| *t == at) {
                events.remove(i);
            }
            if events.is_empty() {
                self.events.remove(key);
            }
        }
    }

    pub fn clear(&mut self, key: &str) {
        self.events.remove(key);
    }
}

/// The key a client's limits count under: an IPv4 address (also when IPv4-mapped), or an IPv6 address's /64, since
/// one IPv6 client usually holds a whole /64.
pub fn client_key(ip: Option<IpAddr>) -> String {
    match ip.map(|ip| ip.to_canonical()) {
        None => "unknown".into(),
        Some(IpAddr::V4(ip)) => ip.to_string(),
        Some(IpAddr::V6(ip)) => format!("{}/64", Ipv6Addr::from(u128::from(ip) & !u128::from(u64::MAX))),
    }
}

/// Failed logins: at most 5 per client IP in 15 minutes and 100 across all clients in an hour.
pub struct LoginLimiter {
    per_ip: SlidingWindow,
    global: SlidingWindow,
}

impl Default for LoginLimiter {
    fn default() -> Self {
        LoginLimiter {
            per_ip: SlidingWindow::new(LOGIN_FAILURES_PER_IP, LOGIN_IP_WINDOW),
            global: SlidingWindow::new(LOGIN_FAILURES_GLOBAL, LOGIN_GLOBAL_WINDOW),
        }
    }
}

impl LoginLimiter {
    /// How long until `ip` may try a password again, or `None` when it may now.
    pub fn retry_after(&mut self, ip: &str, now: Instant) -> Option<Duration> {
        let a = self.per_ip.retry_after(ip, now);
        let b = self.global.retry_after("", now);
        a.max(b)
    }

    /// Counts an attempt from `ip` at `now` as failed before its password is checked, so that a check whose request
    /// is cancelled still counts; `succeeded` takes it back. Returns how long to wait when `ip` may not try now.
    pub fn attempt(&mut self, ip: &str, now: Instant) -> Result<(), Duration> {
        if let Some(wait) = self.retry_after(ip, now) {
            return Err(wait);
        }
        self.per_ip.try_record(ip, now)?;
        if let Err(wait) = self.global.try_record("", now) {
            self.per_ip.forget(ip, now);
            return Err(wait);
        }
        Ok(())
    }

    /// The attempt `ip` made at `at` succeeded: it no longer counts globally, and that IP's failures are cleared.
    pub fn succeeded(&mut self, ip: &str, at: Instant) {
        self.per_ip.clear(ip);
        self.global.forget("", at);
    }
}

/// Whole seconds for `Retry-After`, rounded up and at least 1.
pub fn retry_secs(wait: Duration) -> u64 {
    (wait.as_secs() + u64::from(wait.subsec_nanos() > 0)).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_window_admits_its_limit_then_reports_the_wait() {
        let t0 = Instant::now();
        let mut w = SlidingWindow::new(2, secs(60));
        assert_eq!(w.retry_after("a", t0), None);
        w.try_record("a", t0).unwrap();
        w.try_record("a", t0 + secs(10)).unwrap();
        assert_eq!(w.retry_after("a", t0 + secs(20)), Some(secs(40)));
        assert_eq!(w.try_record("a", t0 + secs(20)), Err(secs(40)));
        assert_eq!(w.retry_after("b", t0 + secs(20)), None);
        // The oldest event leaves the window.
        assert_eq!(w.retry_after("a", t0 + secs(60)), None);
        w.try_record("a", t0 + secs(61)).unwrap();
        assert_eq!(w.retry_after("a", t0 + secs(61)), Some(secs(9)));
        w.forget("a", t0 + secs(61));
        assert_eq!(w.retry_after("a", t0 + secs(61)), None);
        w.try_record("a", t0 + secs(62)).unwrap();
        w.clear("a");
        assert_eq!(w.retry_after("a", t0 + secs(62)), None);
        assert!(w.is_empty());
    }

    #[test]
    fn a_full_window_refuses_new_keys_until_one_expires() {
        let t0 = Instant::now();
        let mut w = SlidingWindow::with_max_keys(2, secs(60), 3);
        for i in 0..3 {
            w.try_record(&format!("k{i}"), t0 + secs(i)).unwrap();
        }
        assert_eq!(w.try_record("new", t0 + secs(10)), Err(secs(50)));
        assert_eq!(w.try_record("other", t0 + secs(20)), Err(secs(40)));
        assert_eq!(w.len(), 3);
        // Tracked keys still record.
        w.try_record("k2", t0 + secs(20)).unwrap();
        // Once k0 expires there is room again.
        w.try_record("new", t0 + secs(60)).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w.retry_after("k0", t0 + secs(60)), None);

        // At full size, the 10,001st client is refused rather than tracked.
        let mut w = SlidingWindow::new(PAIR_STARTS_PER_IP, PAIR_START_WINDOW);
        for i in 0..MAX_KEYS {
            w.try_record(&i.to_string(), t0).unwrap();
        }
        assert_eq!(w.try_record("one more", t0 + secs(1)), Err(PAIR_START_WINDOW - secs(1)));
        assert_eq!(w.len(), MAX_KEYS);
        w.try_record("one more", t0 + PAIR_START_WINDOW).unwrap();
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn calls_do_not_scan_every_key() {
        let t0 = Instant::now();
        let mut w = SlidingWindow::new(5, secs(60));
        for i in 0..5000 {
            w.try_record(&i.to_string(), t0).unwrap();
        }
        assert_eq!(w.sweeps, 1);
        // Recording within a period does not sweep.
        for i in 0..2000 {
            w.try_record(&format!("n{i}"), t0 + secs(30) + Duration::from_millis(i)).unwrap();
        }
        assert_eq!(w.sweeps, 1);
        // Checking one key leaves the other keys' stale events for a later sweep.
        for i in 0..1000 {
            assert_eq!(w.retry_after(&i.to_string(), t0 + secs(61)), None);
        }
        assert_eq!((w.len(), w.sweeps), (6000, 1));
        // The first record after a period sweeps once.
        w.try_record("late", t0 + secs(61)).unwrap();
        w.try_record("later", t0 + secs(62)).unwrap();
        assert_eq!((w.len(), w.sweeps), (2002, 2));

        // A full window looks for room once, then not before its next key expires.
        let mut w = SlidingWindow::with_max_keys(5, secs(60), 10);
        for i in 0..10 {
            w.try_record(&i.to_string(), t0).unwrap();
        }
        let swept = w.sweeps;
        for i in 0..1000 {
            assert!(w.try_record(&format!("n{i}"), t0 + secs(1) + Duration::from_micros(i)).is_err());
        }
        assert_eq!(w.sweeps - swept, 1);
    }

    #[test]
    fn ipv6_clients_count_by_their_64() {
        let key = |ip: &str| client_key(Some(ip.parse().unwrap()));
        assert_eq!(key("2001:db8:1:2::1"), "2001:db8:1:2::/64");
        assert_eq!(key("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
        assert_eq!(key("2001:db8:1:3::1"), "2001:db8:1:3::/64");
        assert_eq!(key("::ffff:192.0.2.9"), "192.0.2.9");
        assert_eq!(key("192.0.2.9"), "192.0.2.9");
        assert_eq!(client_key(None), "unknown");
    }

    #[test]
    fn logins_are_limited_per_ip_and_globally() {
        let t0 = Instant::now();
        let mut l = LoginLimiter::default();
        for i in 0..5 {
            assert_eq!(l.retry_after("1.1.1.1", t0), None, "{i}");
            l.attempt("1.1.1.1", t0).unwrap();
        }
        assert_eq!(l.retry_after("1.1.1.1", t0), Some(LOGIN_IP_WINDOW));
        assert_eq!(l.attempt("1.1.1.1", t0), Err(LOGIN_IP_WINDOW));
        assert_eq!(l.retry_after("2.2.2.2", t0), None);
        assert_eq!(l.retry_after("1.1.1.1", t0 + LOGIN_IP_WINDOW), None);
        let at = t0 + LOGIN_IP_WINDOW;
        l.attempt("1.1.1.1", at).unwrap();
        l.succeeded("1.1.1.1", at);
        assert_eq!(l.retry_after("1.1.1.1", at), None);

        let mut l = LoginLimiter::default();
        for i in 0..99 {
            l.attempt(&format!("10.0.0.{i}"), t0 + secs(i)).unwrap();
        }
        // A success takes back its own attempt, not the other failures.
        let at = t0 + secs(99);
        l.attempt("10.0.0.0", at).unwrap();
        l.succeeded("10.0.0.0", at);
        assert_eq!(l.retry_after("9.9.9.9", at), None);
        l.attempt("10.0.0.99", at).unwrap();
        assert_eq!(l.retry_after("9.9.9.9", t0 + secs(100)), Some(secs(3500)));
        assert_eq!(l.attempt("9.9.9.9", t0 + secs(100)), Err(secs(3500)));
        assert_eq!(l.retry_after("9.9.9.9", t0 + LOGIN_GLOBAL_WINDOW), None);
    }

    #[test]
    fn retry_seconds_round_up() {
        assert_eq!(retry_secs(Duration::from_millis(1500)), 2);
        assert_eq!(retry_secs(Duration::from_secs(3)), 3);
        assert_eq!(retry_secs(Duration::ZERO), 1);
    }
}
