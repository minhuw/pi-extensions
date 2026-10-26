//! A small deterministic PRNG (xoshiro256**) and the distributions the generator needs.

#[derive(Clone)]
pub struct Rng {
    s: [u64; 4],
}

fn splitmix(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut state = seed;
        Rng { s: [splitmix(&mut state), splitmix(&mut state), splitmix(&mut state), splitmix(&mut state)] }
    }

    /// An independent generator for stream `n` of this seed.
    pub fn fork(seed: u64, n: u64) -> Rng {
        Rng::new(seed ^ n.wrapping_mul(0xA24B_AED4_963E_E407).rotate_left(17))
    }

    pub fn u64(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    /// Uniform in [0, 1).
    pub fn f64(&mut self) -> f64 {
        (self.u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform in [0, n).
    pub fn below(&mut self, n: usize) -> usize {
        (((self.u64() >> 32) * n as u64) >> 32) as usize
    }

    /// Uniform in [lo, hi].
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.f64() * (hi - lo + 1) as f64) as i64
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.f64() < p
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    pub fn normal(&mut self) -> f64 {
        let u1 = self.f64().max(1e-300);
        let u2 = self.f64();
        (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }

    /// Log-normal with the given median and log-space sigma.
    pub fn lognormal(&mut self, median: f64, sigma: f64) -> f64 {
        median * (sigma * self.normal()).exp()
    }

    pub fn hex(&mut self, len: usize) -> String {
        const HEX: &[u8] = b"0123456789abcdef";
        (0..len).map(|_| HEX[self.below(16)] as char).collect()
    }

    pub fn uuid(&mut self) -> String {
        let h = self.hex(32);
        format!("{}-{}-4{}-{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[16..20], &h[20..32])
    }
}

/// Vose's alias method: O(1) sampling from a fixed discrete distribution.
pub struct Alias {
    prob: Vec<f64>,
    alias: Vec<u32>,
}

impl Alias {
    pub fn new(weights: &[f64]) -> Alias {
        let n = weights.len();
        let total: f64 = weights.iter().sum();
        let mut scaled: Vec<f64> = weights.iter().map(|w| w * n as f64 / total).collect();
        let mut prob = vec![0.0; n];
        let mut alias = vec![0u32; n];
        let (mut small, mut large): (Vec<usize>, Vec<usize>) = (0..n).partition(|&i| scaled[i] < 1.0);
        while let (Some(s), Some(&l)) = (small.pop(), large.last()) {
            prob[s] = scaled[s];
            alias[s] = l as u32;
            scaled[l] -= 1.0 - scaled[s];
            if scaled[l] < 1.0 {
                large.pop();
                small.push(l);
            }
        }
        for i in small.into_iter().chain(large) {
            prob[i] = 1.0;
        }
        Alias { prob, alias }
    }

    /// Zipf weights `1 / rank^s` for ranks 1..=n.
    pub fn zipf(n: usize, s: f64) -> Alias {
        Alias::new(&(1..=n).map(|r| 1.0 / (r as f64).powf(s)).collect::<Vec<_>>())
    }

    pub fn sample(&self, rng: &mut Rng) -> usize {
        let i = rng.below(self.prob.len());
        if rng.f64() < self.prob[i] { i } else { self.alias[i] as usize }
    }
}
