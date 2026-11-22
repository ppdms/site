import { bindings, defineConfig } from "cf/config";

export default defineConfig((ctx) => {
	switch (ctx.mode) {
		case "preview": {
			return {
				worker: {
					name: "site-preview",
					compatibilityDate: "2026-09-04",
					entrypoint: "./src/worker/index.ts",
					workersDev: false,
					observability: {
						enabled: true,
						headSamplingRate: 1,
					},
					assets: {
						htmlHandling: "auto-trailing-slash",
						notFoundHandling: "404-page",
						runWorkerFirst: [
							"/cv",
							"/CV_Vassilis_Papadimas.pdf",
						],
					},
					domains: [
						"preview.papadim.as",
					],
					env: {
						DATA: bindings.r2({
							name: "data",
						}),
						ASSETS: bindings.assets(),
					},
				},
			};
		}
		default: {
			return {
				worker: {
					name: "site",
					compatibilityDate: "2026-09-04",
					entrypoint: "./src/worker/index.ts",
					workersDev: false,
					observability: {
						enabled: true,
						headSamplingRate: 1,
					},
					assets: {
						htmlHandling: "auto-trailing-slash",
						notFoundHandling: "404-page",
						runWorkerFirst: [
							"/cv",
							"/CV_Vassilis_Papadimas.pdf",
						],
					},
					domains: [
						"papadim.as",
						"www.papadim.as",
					],
					env: {
						DATA: bindings.r2({
							name: "data",
						}),
						ASSETS: bindings.assets(),
					},
				},
			};
		}
	}
});
