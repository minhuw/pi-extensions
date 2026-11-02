export function priceCatalog() {
	return {
		moonshotai: { models: {
			"kimi-k3.1-pro": { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro",
				cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2 } },
			"kimi-k3.1-pro-highspeed": { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed",
				cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 4 } },
		} },
		"coding-plan": { models: {
			"k3.1-pro": { id: "k3.1-pro", name: "Kimi K3.1 Pro", cost: { input: 0, output: 0 } },
			"k3.1-pro-highspeed": { id: "k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", cost: { input: 0, output: 0 } },
		} },
		reseller: { models: {
			"kimi-k3.1-pro": { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", cost: { input: 3.75, output: 18.75 } },
		} },
		another: { models: {
			"kimi-k3.1-pro": { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro",
				cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2 } },
		} },
		newlab: { models: { unfamiliar: { id: "unfamiliar", name: "Unfamiliar", cost: { input: 7, output: 9 } } } },
	};
}
