import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { sleep, sleepSync } from 'bun';
import html from '../src/index';
import { emptyDir, testIfFileExists } from './utils';

describe('Testing Generation of Inlined Minified HTML', async () => {
	const generationDirectory = './test/generation/inline-minify';
	const expectedDirectory = './test/expected/inline-minify';

	if (fs.existsSync(generationDirectory)) emptyDir(generationDirectory);

	await Bun.build({
		entrypoints: ['./test/starting/index.html'],
		minify: true,
		outdir: generationDirectory,
		plugins: [html({ inline: true })],
		naming: '[dir]/[name].[ext]',
	});

	testIfFileExists(generationDirectory, expectedDirectory, 'index.html');
	testIfFileExists(
		generationDirectory,
		expectedDirectory,
		'images/favicon.ico',
	);
});
