/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import fs from 'node:fs/promises';
import os from 'node:os';
import path, { resolve } from 'node:path';
import {
	type BuildArtifact,
	type BuildConfig,
	type BunFile,
	type BunPlugin,
	type PluginBuilder,
	file,
} from 'bun';
import CleanCSS, { type OptionsOutput as CleanCssOptions } from 'clean-css';
import {
	type Options as HTMLTerserOptions,
	minify,
} from 'html-minifier-terser';
import * as sass from 'sass';
import { type MinifyOptions, minify as terser } from 'terser';
import {
	type FileDetails,
	Processor,
	attributeToSelector,
	changeFileExtension,
	contentToString,
	findLastCommonPath,
	getColumnNumber,
	getLines,
	isURL,
	removeCommonPath,
	returnLineNumberOfOccurance,
} from './utils';

export type File = {
	file: BunFile;
	details: FileDetails;
};

export type BunPluginHTMLOptions = {
	/**
	 * Whether to inline all files or not. Additionally, you can choose whether to inline just
	 * css and js files.
	 */
	inline?:
		| boolean
		| {
				css?: boolean;
				js?: boolean;
		  };
	/**
	 * `bun-plugin-html` already respects the default naming rules of Bun.build, but if you wish to override
	 * that behavior for the naming of css files, then you can do so here.
	 */
	naming?: {
		css?: string;
	};
	/**
	 * Choose how the content is minified, if `Bun.build({ minify: true })` is set.
	 */
	minifyOptions?: HtmlMinifyOptions;
	/**
	 * Choose what extensions to include in building of javascript files with `Bun.build`.
	 *
	 * Defaults are `.js`, `.jsx`, `.ts`, and `.tsx` files.
	 */
	includeExtensions?: string[];
	/**
	 * Choose which extensions to exclude from Bun.build processing.
	 */
	excludeExtensions?: string[];
	/**
	 * Choose which selectors to exclude. Only one is excluded by default, that being `a`
	 */
	excludeSelectors?: string[];
	/**
	 * Processes the files before they are processed by `bun-plugin-html`. Useful for things like tailwindcss.
	 */
	preprocessor?: (processor: Processor) => void | Promise<void>;
	/**
	 * Determines whether file paths in the source code are replaced by new paths.
	 * - If `true`, path replacement is completely skipped.
	 * - If an array of strings is provided, only the specified file paths are excluded from replacement.
	 * - If omitted or `false`, all paths are replaced by default.
	 */
	keepOriginalPaths?: boolean | string[];
	/**
	 * Whether or not to suppress errors from being logged when building. Useful for when you know what
	 * you are doing works, but are still getting errors. `true` means that the errors won't be logged.
	 */
	suppressErrors?: boolean;
};

const attributesToSearch = [
	'src',
	'href',
	'data',
	'action',
	'data-src',
	'lowsrc',
] as const;
const extensionsToBuild: readonly string[] = [
	'.js',
	'.jsx',
	'.ts',
	'.tsx',
] as const;
const selectorsToExclude: readonly string[] = ['a'] as const;

export type HtmlMinifyOptions = HTMLTerserOptions & {
	minifyHTML?: boolean;
};
export const defaultMinifyOptions: HtmlMinifyOptions = {
	collapseWhitespace: true,
	collapseInlineTagWhitespace: true,
	caseSensitive: true,
	minifyCSS: {},
	minifyJS: true,
	minifyHTML: true,
	removeComments: true,
	removeRedundantAttributes: true,
} as const;

async function getAllFiles(
	options: BunPluginHTMLOptions | undefined,
	filePath: string,
	excluded: readonly string[],
) {
	const extension = path.parse(filePath).ext;
	if (extension !== '.htm' && extension !== '.html') return [];

	const files: File[] = [];
	const rewriter = new HTMLRewriter();

	const htmlResolvedPath = path.resolve(filePath);
	const originalFile = Bun.file(htmlResolvedPath);
	let fileText = await originalFile.text();

	const hash = Bun.hash(fileText, 1).toString(16).slice(0, 8);

	files.push({
		file: originalFile,
		details: {
			kind: 'entry-point',
			hash,
			originalPath: htmlResolvedPath,
			htmlImporter: htmlResolvedPath,
		},
	});

	let excludedSelector = '';

	for (const exclude of excluded) {
		excludedSelector += `:not(${exclude})`;
	}

	rewriter.on(excludedSelector, {
		async element(el) {
			let attributeName: string | undefined;
			let attributeValue: string | null | undefined;

			for (const attribute of attributesToSearch) {
				if (el.hasAttribute(attribute)) {
					attributeName = attribute;
					attributeValue = el.getAttribute(attribute);
					break;
				}
			}

			if (!attributeName || !attributeValue || isURL(attributeValue)) return;
			const resolvedPath = path.resolve(path.dirname(filePath), attributeValue);
			const extension = path.parse(resolvedPath).ext;
			if (options?.excludeExtensions?.includes(extension)) return;
			const file = Bun.file(resolvedPath);

			if (!(await file.exists())) {
				fileText = fileText.replace(/\t/g, '	');
				const search = `${attributeName}="${attributeValue}"`;
				const line = returnLineNumberOfOccurance(fileText, search);
				const columnNumber =
					getColumnNumber(
						fileText,
						fileText.indexOf(search) + search.length / 2,
					) +
					`${line}`.length +
					1;
				if (options?.suppressErrors !== true) {
					console.log(getLines(fileText, 4, line + 1));
					console.log('^'.padStart(columnNumber));
					console.error(
						`bun-plugin-html - HTMLParseError: Specified <${el.tagName}> ${attributeName} '${attributeValue}' does not exist!`,
					);
					console.log(`	  at ${filePath}:${line}:${columnNumber}`);
				}
				return;
			}

			files.push({
				file,
				details: {
					kind: 'chunk',
					attribute: {
						name: attributeName,
						value: attributeValue,
					},
					hash,
					originalPath: resolvedPath,
					htmlImporter: htmlResolvedPath,
				},
			});
		},
	});

	rewriter.transform(fileText);

	return files;
}

function getExtensionFiles(
	files: Map<BunFile, FileDetails>,
	extensions: readonly string[],
) {
	const result: File[] = [];
	for (const [file, details] of files.entries()) {
		if (!file.name) continue;
		const extension = path.parse(file.name).ext;
		if (!extensions.includes(extension)) continue;

		result.push({ file, details });
	}

	return result;
}

function getCSSMinifier(
	config: BuildConfig,
	options: HtmlMinifyOptions,
): (text: string) => string {
	if (config.minify && options.minifyCSS !== false) {
		if (typeof options.minifyCSS === 'function') {
			return options.minifyCSS as (text: string) => string;
		}
		const cssOptions =
			typeof options.minifyCSS === 'object'
				? (options.minifyCSS as CleanCssOptions)
				: {};
		const minifier = new CleanCSS(cssOptions);

		return (text: string) => {
			const output = minifier.minify(text);
			output.warnings.forEach(console.warn);
			if (output.errors.length > 0) {
				output.errors.forEach(console.error);
				return text;
			}
			return output.styles;
		};
	}
	return (text: string) => text;
}

function getJSMinifier(
	config: BuildConfig,
	options: HtmlMinifyOptions,
): (text: string) => Promise<string> {
	const noop = async (text: string) => text;
	if (config.minify) {
		return async (text: string) => {
			if (typeof options.minifyJS === 'function') {
				return options.minifyJS(text, false);
			}
			if (typeof options.minifyJS === 'object') {
				const result = await terser(text, options.minifyJS as MinifyOptions);
				return result.code ? result.code : text;
			}
			return text;
		};
	}
	return noop;
}

async function forJsFiles(
	options: BunPluginHTMLOptions | undefined,
	build: PluginBuilder,
	files: Map<BunFile, FileDetails>,
	buildExtensions: readonly string[],
	htmlOptions: HtmlMinifyOptions,
) {
	const jsFiles = getExtensionFiles(files, buildExtensions);
	for (const item of jsFiles) files.delete(item.file);

	if (build.config.experimentalCss) {
		const cssFiles = await forStyleFiles(options, build, htmlOptions, files);
		if (cssFiles) {
			for (const file of cssFiles) {
				jsFiles.push(file);
			}
		}
	}

	if (!jsFiles) return;

	const naming: BuildConfig['naming'] = {};
	if (typeof build.config.naming === 'string') {
		naming.entry = build.config.naming;
		naming.chunk = build.config.naming;
		naming.asset = build.config.naming;
	} else if (typeof build.config.naming === 'object') {
		naming.entry = build.config.naming.chunk;
		naming.chunk = build.config.naming.chunk;
		naming.asset = build.config.naming.asset;
	} else {
		naming.entry = './[name]-[hash].[ext]';
	}

	const entrypoints = jsFiles.map((item) => item.file.name as string);
	if (entrypoints.length === 0) return;
	const commonPath = findLastCommonPath(entrypoints);

	const requiresTempDir = jsFiles.some(
		(file) => file.details.content !== undefined,
	);
	const tempDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'bun-build-'));

	if (requiresTempDir) {
		// Write files with `content` to the temporary directory
		await Promise.all(
			jsFiles.map(async (item, index) => {
				if (!item.file.name) return;
				const filePath = removeCommonPath(item.file.name, commonPath);
				const tempFilePath = path.resolve(tempDirPath, filePath);
				await Bun.write(tempFilePath, item.details.content ?? item.file);
				entrypoints[index] = tempFilePath;
			}),
		);
	}

	const toReplacePaths: {
		from: string;
		path: string;
		resolved: string;
	}[] = [];

	const customResolver = (resolverOptions: {
		pathToResolveFrom: string;
	}): BunPlugin => {
		return {
			name: 'Custom Resolver',
			setup(build) {
				build.onResolve({ filter: /[\s\S]*/ }, async (args) => {
					try {
						if (isURL(args.path)) return;
						let resolved: string;
						let external = false;
						const tempPath = path.resolve(tempDirPath, args.path);
						const originalPath = path.resolve(
							args.path,
							resolverOptions.pathToResolveFrom,
						);

						// Check if the path is a module
						const isModule =
							!args.path.startsWith('./') &&
							!args.path.startsWith('../') &&
							!args.path.startsWith('/');

						if (await Bun.file(tempPath).exists()) {
							resolved = Bun.resolveSync(args.path, tempDirPath);
						} else if (isModule || (await Bun.file(originalPath).exists())) {
							resolved = Bun.resolveSync(
								args.path,
								resolverOptions.pathToResolveFrom,
							);
						} else {
							resolved = path.resolve(args.importer, '../', args.path);

							const exists = await fs.exists(resolved);

							if (!isModule) {
								if (exists) {
									if ((await fs.lstat(resolved)).isDirectory()) {
										if (requiresTempDir)
											resolved = Bun.resolveSync(args.path, originalPath);
										else resolved = Bun.resolveSync('.', resolved);
									} else {
										resolved = Bun.resolveSync(
											args.path,
											path.parse(args.importer).dir,
										);
									}
								} else {
									resolved = Bun.resolveSync('.', resolved);
								}
							}

							if (build.config.splitting) {
								external = true;
								toReplacePaths.push({
									from: args.importer,
									resolved,
									path: args.path,
								});
							}
						}

						return {
							...args,
							path: resolved,
							external,
						};
					} catch (error) {
						if (options?.suppressErrors !== true) {
							console.error('Error during module resolution:');
							console.error('Potential reasons:');
							console.error('- Missing file in specified paths');
							console.error('- Invalid file type (non-JS file)');
							console.error(
								'If unresolved, please report to `bun-plugin-html`.',
							);
							console.error(error);
						}

						// Return an empty path to prevent build failure
						return {
							...args,
							path: '',
						};
					}
				});
			},
		};
	};

	const entrypointToOutput: Map<string, string> = new Map();
	for (const [index, entrypoint] of entrypoints.entries()) {
		const result = await Bun.build({
			...build.config,
			entrypoints: [entrypoint],
			naming,
			outdir: undefined,
			plugins: [
				customResolver({
					pathToResolveFrom: commonPath,
				}),
				...build.config.plugins.filter(
					(plugin) => plugin.name !== 'bun-plugin-html',
				),
			],
			root: build.config.root || commonPath,
		});

		if (!result.success && options?.suppressErrors !== true) {
			console.error(result.logs);
		}

		for (const output of result.outputs) {
			const outputText = await output.text();
			let filePath = path.resolve(`${commonPath}/${output.path}`);
			if (filePath.includes(tempDirPath)) {
				filePath = filePath.replace(`/private${tempDirPath}`, commonPath);
				filePath = filePath.replace(tempDirPath, commonPath);
			}

			if (output.kind === 'entry-point' || output.loader === 'css') {
				if (!jsFiles[index].file.name) continue;
				entrypointToOutput.set(jsFiles[index].file.name, filePath);
				files.set(Bun.file(filePath), {
					content: outputText,
					attribute: jsFiles[index].details.attribute,
					kind: jsFiles[index].details.kind,
					hash: output.hash || Bun.hash(outputText, 1).toString(16).slice(0, 8),
					originalPath: jsFiles[index].details.originalPath,
					htmlImporter: jsFiles[index].details.htmlImporter,
				});
			} else {
				files.set(Bun.file(filePath), {
					content: outputText,
					kind: output.kind,
					hash: output.hash || Bun.hash(outputText, 1).toString(16).slice(0, 8),
					originalPath: false,
					htmlImporter: jsFiles[index].details.htmlImporter,
				});
			}
		}
	}

	for (const [file, details] of files) {
		const toReplace = toReplacePaths.find(
			(item) => entrypointToOutput.get(item.from) === file.name,
		);
		if (!toReplace) continue;
		const output = entrypointToOutput.get(toReplace.resolved);
		const fromOutput = entrypointToOutput.get(toReplace.from);
		if (!output || !fromOutput) continue;
		const newPath = path.relative(path.parse(fromOutput).dir, output);
		details.content = (await contentToString(details.content))
			.replaceAll(`from "${toReplace.path}"`, `from "./${newPath}"`)
			.replaceAll(`from"${toReplace.path}"`, `from"./${newPath}"`)
			.replaceAll(`require("${toReplace.path}")`, `require("./${newPath}")`);
	}
}

async function forStyleFiles(
	options: BunPluginHTMLOptions | undefined,
	build: PluginBuilder,
	htmlOptions: HtmlMinifyOptions,
	files: Map<BunFile, FileDetails>,
) {
	const cssMinifier = getCSSMinifier(build.config, htmlOptions);
	const cssFiles = getExtensionFiles(files, ['.css', '.scss', '.sass']);

	if (!cssFiles) return;

	for (const item of cssFiles) {
		const file = item.file;
		let content =
			(await contentToString(item.details.content)) || (await file.text());
		const { originalPath } = item.details;
		if (/\.s[ac]ss$/i.test(originalPath || '')) {
			content = sass.compileString(content, { style: 'compressed' }).css;
		} else {
			content = cssMinifier(content);
		}

		if (!build.config.experimentalCss)
			files.set(file, {
				content,
				attribute: item.details.attribute,
				kind: item.details.kind,
				hash: Bun.hash(content, 1).toString(16).slice(0, 8),
				originalPath: originalPath,
				htmlImporter: item.details.htmlImporter,
			});
		else files.delete(file);
	}

	if (build.config.experimentalCss) return cssFiles;
}

interface NamedAs {
	[name: string]: {
		[dir: string]: {
			as: string;
			fd: BunFile;
		};
	};
}

function mapIntoKeys(files: Map<BunFile, FileDetails>) {
	const keys = [];
	for (const key of files.keys()) {
		keys.push(key.name as string);
	}

	return keys;
}

async function processHtmlFiles(
	options: BunPluginHTMLOptions | undefined,
	build: PluginBuilder,
	files: Map<BunFile, FileDetails>,
	buildExtensions: readonly string[],
) {
	const htmlFiles = getExtensionFiles(files, ['.html', '.htm']);
	const toChangeAttributes: ((
		rewriter: HTMLRewriter,
		fileLocation: string,
	) => void)[] = [];

	if (!htmlFiles) return toChangeAttributes;

	for (const htmlFile of htmlFiles) {
		for (const [file, details] of files) {
			const attribute = details.attribute;
			if (attribute) {
				const selector = attributeToSelector(attribute);

				if (!file.name) continue;
				const extension = path.parse(file.name).ext;

				if (/\.(c|s[ac])ss$/i.test(extension)) {
					if (
						options &&
						(options.inline === true ||
							(typeof options.inline === 'object' &&
								options.inline?.css === true))
					) {
						files.delete(file);
						toChangeAttributes.push((rewriter: HTMLRewriter) => {
							rewriter.on(selector, {
								async element(el) {
									let content =
										(await contentToString(details.content)) ||
										(await file.text());
									if (/\.s[ac]ss$/i.test(extension)) {
										content = sass.compileString(content).css;
									}
									el.replace(`<style>${content}</style>`, {
										html: true,
									});
								},
							});
						});
					}
				} else if (buildExtensions.includes(extension)) {
					if (
						options &&
						(options.inline === true ||
							(typeof options.inline === 'object' &&
								options.inline?.js === true))
					) {
						files.delete(file);

						toChangeAttributes.push((rewriter: HTMLRewriter) => {
							rewriter.on(selector, {
								async element(el) {
									const contentToStringThing = await contentToString(
										details.content,
									);
									let content: string;
									if (details.content === undefined)
										content = await file.text();
									else content = await contentToString(details.content);
									content = content.replaceAll(/(<)(\/script>)/g, '\\x3C$2');

									el.removeAttribute('src');
									el.setInnerContent(content, {
										html: true,
									});
								},
							});
						});
					}
				} else {
					files.set(file, {
						...details,
						hash: Bun.hash(await file.arrayBuffer(), 1)
							.toString(16)
							.slice(0, 8),
						kind: 'asset',
					});
				}
			}
		}
	}

	return toChangeAttributes;
}

function keepNamedAs(
	parsedOriginPath: path.ParsedPath,
	parsedNewPath: path.ParsedPath,
	resolved: string,
	namedAs: NamedAs,
) {
	const { root, dir, base } = parsedOriginPath;
	const names = namedAs[base] || {};
	const nameDir = path.join(root, dir);
	if (!names[nameDir]) {
		const as = path.join(
			parsedNewPath.root,
			parsedNewPath.dir,
			parsedNewPath.base,
		);
		if (as !== path.join(nameDir, base)) {
			names[nameDir] = { as, fd: Bun.file(resolved) };
			namedAs[base] = names;
		}
	}
	return names[nameDir];
}

async function renameFile(
	options: BunPluginHTMLOptions | undefined,
	build: PluginBuilder,
	file: BunFile,
	hash: string,
	kind: BuildArtifact['kind'],
	sharedPath: string,
	namedAs: NamedAs,
) {
	let buildNamingType: 'chunk' | 'entry' | 'asset' = 'asset';
	if (kind === 'entry-point') buildNamingType = 'entry';
	if (kind === 'chunk') buildNamingType = 'chunk';
	if (kind === 'sourcemap' || kind === 'bytecode') return file;

	if (!file.name) return file;
	const extension = path.parse(file.name).ext;

	let naming: string | undefined;
	if (/\.(c|s[ac])ss$/i.test(extension) && options && options.naming?.css) {
		naming = options.naming.css;
	} else if (typeof build.config.naming === 'string') {
		naming = build.config.naming;
	} else if (typeof build.config.naming === 'object') {
		naming = build.config.naming[buildNamingType];
	}

	if (!naming) return file;

	let filePath = path.normalize(file.name);
	filePath = filePath.replace(`${sharedPath}`, '.');
	const parsedPath = path.parse(filePath);

	const dir = parsedPath.dir;
	let ext = parsedPath.ext.replace('.', '');
	const name = parsedPath.name;

	if (/s[ac]ss$/i.test(ext)) {
		ext = 'css';
	}

	const newPath = naming
		.replaceAll('[dir]', dir)
		.replaceAll('[hash]', `${hash}`)
		.replaceAll('[ext]', ext)
		.replaceAll('[name]', name);

	const resolved = path.resolve(sharedPath, newPath);

	const newPathParsed = path.parse(newPath);
	const named = keepNamedAs(parsedPath, newPathParsed, resolved, namedAs);
	return named?.fd || Bun.file(resolved);
}

const html = (options?: BunPluginHTMLOptions): BunPlugin => {
	const _keepOriginalPaths = options?.keepOriginalPaths;
	const _namedAs: NamedAs = {};
	const _pathSaved: { [path: string]: boolean } = {};

	const save = async (
		name: string,
		body: Blob | NodeJS.TypedArray | ArrayBufferLike | string | Bun.BlobPart[],
		options?: Parameters<typeof Bun.write>[2],
		outdir?: string,
	) => {
		if (_pathSaved[name]) return; // avoid duplicated-saving a file
		_pathSaved[name] = true;
		if (_keepOriginalPaths === true || typeof body !== 'string') {
			return await Bun.write(name, body, options);
		}
		// replace mapping items string inside body
		let content = body;
		// host relative dir
		const hostDir = path.relative(outdir || '.', path.parse(name).dir);

		const originNames = Object.keys(_namedAs);
		for (let j = 0; j < originNames.length; j++) {
			const originName = originNames[j];
			const originNameMatcher = originName.replace(/\./g, '\\.');
			const clue = new RegExp(
				`(['"])([^'"\\n]*\/)?${originNameMatcher}([?#][^'"]*)?\\1|\\(([^\\)\\n'"]+\/)?${originNameMatcher}([?#][^'"\\)]*)?\\)`,
				'g',
			);
			const pathStrings = content.match(clue);
			if (!pathStrings) continue;
			const asNewNames = _namedAs[originName];
			for (let i = 0; i < pathStrings.length; i++) {
				const pathStrCtx: string = pathStrings[i];
				let [prefix, pathString, suffix]: string[] = [
					pathStrCtx.substring(0, 1),
					pathStrCtx.substring(1, pathStrCtx.length - 1),
					pathStrCtx.substring(pathStrCtx.length - 1),
				];
				if (isURL(pathString)) continue;
				const pathExtraTail = pathString.match(/[?#]/);
				if (pathExtraTail?.index) {
					// with extra query or hash
					suffix = pathString.substring(pathExtraTail.index) + suffix;
					pathString = pathString.substring(0, pathExtraTail.index);
				}
				if (
					Array.isArray(_keepOriginalPaths) &&
					_keepOriginalPaths.length > 0 &&
					_keepOriginalPaths.some(
						(s) => pathString.length >= s.length && pathString.endsWith(s),
					)
				)
					continue;

				for (const originDir in asNewNames) {
					const originPath = path.join(originDir, originName);
					let { as: newPath } = asNewNames[originDir];
					if (pathString.startsWith('/')) {
						newPath = `/${newPath}`;
					} else if (
						pathString.replace(/^\.\//, '') !== originPath.replace(/^\.\//, '')
					) {
						const pathStrDir = path.parse(path.join(hostDir, pathString)).dir;
						if (pathStrDir !== originDir) continue; // same dir
						newPath = path.relative(hostDir, newPath);
					}
					content = content.replace(pathStrCtx, `${prefix}${newPath}${suffix}`);
				}
			}
		}
		return await Bun.write(name, content, options);
	};

	return {
		name: 'bun-plugin-html',
		async setup(build) {
			build.onLoad({ filter: /\.(html|htm)$/ }, async (args) => {
				throw new Error(
					'bun-plugin-html does not support output information at this time.',
				);
			});

			const htmlOptions = options?.minifyOptions ?? defaultMinifyOptions;

			const excluded = options?.excludeSelectors
				? options.excludeSelectors.concat(selectorsToExclude)
				: selectorsToExclude;
			const buildExtensions = options?.includeExtensions
				? options.includeExtensions.concat(extensionsToBuild)
				: extensionsToBuild;

			const filesPromises = await Promise.all(
				build.config.entrypoints.map((entrypoint) =>
					getAllFiles(options, entrypoint, excluded),
				),
			);
			let files: Map<BunFile, FileDetails> = new Map(
				filesPromises.flat().map((item) => [item.file, item.details]),
			);
			if (!files.size) return;

			if (options?.preprocessor) {
				const processor = new Processor(files);
				await options.preprocessor(processor);
				files = processor.export();
			}

			await forJsFiles(options, build, files, buildExtensions, htmlOptions);
			if (!build.config.experimentalCss)
				await forStyleFiles(options, build, htmlOptions, files);

			const attributesToChange = await processHtmlFiles(
				options,
				build,
				files,
				buildExtensions,
			);

			const keys = mapIntoKeys(files);
			const commonPath = findLastCommonPath(keys);

			const newFiles: [BunFile, FileDetails][] = [];

			for (const [file, details] of files.entries()) {
				if (!file.name) continue;
				const extension = path.parse(file.name).ext;
				const content = details.content ?? file;

				if (buildExtensions.includes(extension)) {
					let filePath = removeCommonPath(file.name, commonPath);
					const parsedNewPath = path.parse(filePath);
					if (build.config.outdir)
						filePath = path.resolve(build.config.outdir, filePath);
					const named = details.originalPath
						? keepNamedAs(
								path.parse(removeCommonPath(details.originalPath, commonPath)),
								parsedNewPath,
								filePath,
								_namedAs,
							)
						: undefined;
					newFiles.push([
						named?.fd || Bun.file(filePath),
						{
							content,
							attribute: details.attribute,
							kind: details.kind,
							hash: details.hash,
							originalPath: details.originalPath,
							htmlImporter: details.htmlImporter,
						},
					]);
					continue;
				}

				const newFile = await renameFile(
					options,
					build,
					file,
					details.hash,
					details.kind,
					commonPath,
					_namedAs,
				);
				if (!newFile.name) continue;
				let filePath = removeCommonPath(newFile.name, commonPath);
				if (build.config.outdir)
					filePath = path.resolve(build.config.outdir, filePath);
				newFiles.push([
					Bun.file(filePath),
					{
						content,
						attribute: details.attribute,
						kind: details.kind,
						hash: details.hash,
						originalPath: details.originalPath,
						htmlImporter: details.htmlImporter,
					},
				]);
			}

			const commonPathOutput = findLastCommonPath(
				newFiles.map(([name]) => name.name as string),
			);

			for (const [file, details] of newFiles.filter(
				([file, details]) => details.kind !== 'entry-point',
			)) {
				const { name } = file;
				if (!name || !details.content) continue;
				if (name.indexOf(details.hash) > -1 && (await fs.exists(name)))
					continue;
				await save(
					name,
					details.content,
					{
						createPath: true,
					},
					build.config.outdir,
				);

				if (!details.attribute) continue;
				const attribute = details.attribute;
				const selector = attributeToSelector(attribute);
				const extension = path.parse(name).ext;

				attributesToChange.push((rewriter, fileLocation) => {
					rewriter.on(selector, {
						element(el) {
							if (el.getAttribute(attribute.name) === null || !file.name)
								return;

							let filePath = path.relative(
								path.dirname(fileLocation),
								file.name,
							);

							if (buildExtensions.includes(extension))
								filePath = changeFileExtension(filePath, '.js');

							el.setAttribute(attribute.name, filePath);
						},
					});
				});
			}

			for (const [file, details] of newFiles.filter(
				([file, details]) => details.kind === 'entry-point',
			)) {
				let fileContents = await contentToString(details.content);
				const rewriter = new HTMLRewriter();
				for (const item of attributesToChange)
					item(rewriter, file.name as string);
				fileContents = rewriter.transform(fileContents);
				fileContents =
					build.config.minify && htmlOptions.minifyHTML
						? await minify(fileContents, htmlOptions)
						: fileContents;

				const { name } = file;
				if (!name) continue;
				if (name.indexOf(details.hash) > -1 && (await fs.exists(name)))
					continue;
				await save(
					name,
					fileContents,
					{
						createPath: true,
					},
					build.config.outdir,
				);
			}
		},
	};
};

export default html;
