import { defineConfig } from 'vite';
import { wowFiles } from './tools/wowFiles.ts';

export default defineConfig({
	plugins: [wowFiles()],
	// Relative, so the build works both at the root (portable, dev) and under a subpath (GitHub Pages).
	base: './',
	build: {
		// three.js alone is ~500 kB.
		chunkSizeWarningLimit: 1000,
	},
});
