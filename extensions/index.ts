/**
 * Codex Image Generation for pi
 *
 * Registers an `image_gen` tool that calls ChatGPT/Codex's Responses endpoint
 * with the native `image_generation` tool. This reuses pi's `openai-codex`
 * OAuth credentials instead of requiring OPENAI_API_KEY.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { getCapabilities } from "@mariozechner/pi-tui";
import { type Static, Type } from "typebox";

const PROVIDER = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_RESPONSE_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_OUTPUT_FORMAT: OutputFormat = "png";
const DEFAULT_QUALITY: Quality = "medium";
const DEFAULT_SIZE = "auto";
const DEFAULT_SAVE_MODE: SaveMode = "global";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;

const ACTIONS = ["generate", "edit", "auto"] as const;
const BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const INPUT_FIDELITIES = ["high", "low"] as const;
const MODERATIONS = ["auto", "low"] as const;
const OUTPUT_FORMATS = ["png", "webp", "jpeg"] as const;
const QUALITIES = ["low", "medium", "high", "auto"] as const;
const SAVE_MODES = ["none", "project", "global", "custom"] as const;

type Action = (typeof ACTIONS)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type Quality = (typeof QUALITIES)[number];
type SaveMode = (typeof SAVE_MODES)[number];

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({
		description: "The complete image prompt. Include all visual requirements, exact text, constraints, and avoid-list details.",
	}),
	model: Type.Optional(
		Type.String({
			description: "Image generation model. Defaults to gpt-image-2.",
		}),
	),
	responseModel: Type.Optional(
		Type.String({
			description:
				"Codex Responses model used to invoke the native image_generation tool. Defaults to the active openai-codex model, then gpt-5.5.",
		}),
	),
	action: Type.Optional(
		StringEnum(ACTIONS, {
			description: "Whether the native image_generation tool should generate, edit, or decide automatically. Defaults to generate without images and auto with images.",
		}),
	),
	imagePaths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional local image paths to provide as edit targets or references. Relative paths are resolved from the current project directory.",
		}),
	),
	background: Type.Optional(
		StringEnum(BACKGROUNDS, {
			description:
				"Native background mode. gpt-image-2 does not support transparent; for transparency, generate on a flat chroma-key background and remove it locally.",
		}),
	),
	inputFidelity: Type.Optional(
		StringEnum(INPUT_FIDELITIES, {
			description: "Input image fidelity for models that support it. Do not set for gpt-image-2.",
		}),
	),
	moderation: Type.Optional(StringEnum(MODERATIONS)),
	outputCompression: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 100,
			description: "Compression level for jpeg/webp output.",
		}),
	),
	outputFormat: Type.Optional(
		StringEnum(OUTPUT_FORMATS, {
			description: "Generated image format. Defaults to png.",
		}),
	),
	partialImages: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 3,
			description: "Number of partial images to stream from the native image_generation tool, 0-3.",
		}),
	),
	quality: Type.Optional(
		StringEnum(QUALITIES, {
			description: "Image quality. Defaults to medium for gpt-image-2.",
		}),
	),
	size: Type.Optional(
		Type.String({
			description:
				"Image size. Defaults to auto. gpt-image-2 supports auto or WIDTHxHEIGHT subject to model constraints.",
		}),
	),
	save: Type.Optional(
		StringEnum(SAVE_MODES, {
			description: "Save mode. Defaults to global (~/.pi/agent/generated-images/codex-image-gen).",
		}),
	),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save generated image when save=custom. Relative paths resolve from the project directory.",
		}),
	),
	outputPath: Type.Optional(
		Type.String({
			description:
				"Optional exact output file path. Relative paths resolve from the project directory. If omitted, save mode chooses a generated filename.",
		}),
	),
	overwrite: Type.Optional(
		Type.Boolean({
			description: "Allow outputPath to overwrite an existing file. Defaults to false.",
		}),
	),
	baseUrl: Type.Optional(
		Type.String({
			description: "Advanced: Codex backend base URL. Defaults to the active openai-codex model base URL or https://chatgpt.com/backend-api.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface ExtensionConfig {
	baseUrl?: string;
	imageModel?: string;
	outputFormat?: OutputFormat;
	quality?: Quality;
	responseModel?: string;
	save?: SaveMode;
	saveDir?: string;
	size?: string;
}

interface ParsedCredentials {
	accessToken: string;
	accountId: string;
}

interface InputImage {
	path: string;
	mimeType: string;
	base64: string;
}

interface ImageGenerationItem {
	type: "image_generation_call";
	id: string;
	status: string;
	revised_prompt?: string;
	result?: string | null;
}

interface CodexImageResult {
	image: ImageGenerationItem;
	responseId?: string;
}

interface SaveResult {
	mode: SaveMode | "outputPath";
	path?: string;
}

interface ToolDetails {
	provider: string;
	endpoint: string;
	responseModel: string;
	imageModel: string;
	imageCallId: string;
	status: string;
	revisedPrompt?: string;
	savedPath?: string;
	saveMode: SaveResult["mode"];
	outputFormat: OutputFormat;
	quality: Quality;
	size: string;
	responseId?: string;
}

interface ToolContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

function readConfigFile(path: string): ExtensionConfig {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ExtensionConfig;
		return parsed ?? {};
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): ExtensionConfig {
	const globalConfig = readConfigFile(join(getAgentDir(), "extensions", "codex-image-gen.json"));
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", "codex-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

function isSaveMode(value: string): value is SaveMode {
	return SAVE_MODES.includes(value as SaveMode);
}

function isOutputFormat(value: string): value is OutputFormat {
	return OUTPUT_FORMATS.includes(value as OutputFormat);
}

function isQuality(value: string): value is Quality {
	return QUALITIES.includes(value as Quality);
}

function normalizeOutputFormat(format: string | undefined): OutputFormat {
	const value = (format || DEFAULT_OUTPUT_FORMAT).toLowerCase();
	if (value === "jpg") return "jpeg";
	if (!isOutputFormat(value)) {
		throw new Error("outputFormat must be png, webp, or jpeg.");
	}
	return value;
}

function outputFormatFromPath(path: string | undefined): OutputFormat | undefined {
	if (!path) return undefined;
	const ext = extname(stripAtPrefix(path)).toLowerCase().replace(/^\./, "");
	if (!ext) return undefined;
	if (ext === "jpg") return "jpeg";
	return isOutputFormat(ext) ? ext : undefined;
}

function resolveOutputFormat(params: ToolParams, config: ExtensionConfig): OutputFormat {
	return normalizeOutputFormat(
		params.outputFormat ||
			process.env.PI_CODEX_IMAGE_OUTPUT_FORMAT ||
			config.outputFormat ||
			outputFormatFromPath(params.outputPath),
	);
}

function extensionForOutputFormat(format: OutputFormat): string {
	return format === "jpeg" ? "jpg" : format;
}

function mimeForOutputFormat(format: OutputFormat): string {
	return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

function getConfiguredImageWidthCells(): number {
	const value = Number.parseInt(process.env.PI_CODEX_IMAGE_WIDTH_CELLS || "", 10);
	if (!Number.isFinite(value)) return 60;
	return Math.max(1, value);
}

function mimeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return "image/png";
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function resolvePath(cwd: string, path: string): string {
	const normalized = stripAtPrefix(path);
	return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

async function loadInputImages(cwd: string, imagePaths: string[] | undefined): Promise<InputImage[]> {
	if (!imagePaths || imagePaths.length === 0) return [];
	const images: InputImage[] = [];
	for (const rawPath of imagePaths) {
		const path = resolvePath(cwd, rawPath);
		const info = await stat(path);
		if (!info.isFile()) {
			throw new Error(`Input image is not a file: ${path}`);
		}
		if (info.size > MAX_INPUT_IMAGE_BYTES) {
			throw new Error(`Input image exceeds 50MB limit: ${path}`);
		}
		const bytes = await readFile(path);
		images.push({ path, mimeType: mimeForPath(path), base64: bytes.toString("base64") });
	}
	return images;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const payload = token.split(".")[1];
		if (!payload) return null;
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	const auth = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId === "string" && accountId.length > 0) {
		return accountId;
	}
	throw new Error("Failed to extract ChatGPT account id from Codex auth token. Run /login for openai-codex again.");
}

async function getCodexCredentials(ctx: { modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> } }): Promise<ParsedCredentials> {
	const accessToken = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!accessToken) {
		throw new Error("Missing Codex auth. Run /login and choose ChatGPT Plus/Pro (Codex Subscription), then try image_gen again.");
	}
	return { accessToken, accountId: extractAccountId(accessToken) };
}

function resolveCodexResponsesUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveImageModel(params: ToolParams, config: ExtensionConfig): string {
	return params.model || process.env.PI_CODEX_IMAGE_MODEL || config.imageModel || DEFAULT_IMAGE_MODEL;
}

function resolveResponseModel(
	params: ToolParams,
	config: ExtensionConfig,
	ctxModel: { provider?: string; id?: string; input?: string[] } | undefined,
): string {
	const activeCodexImageModel =
		ctxModel?.provider === PROVIDER && ctxModel.input?.includes("image") ? ctxModel.id : undefined;
	return (
		params.responseModel ||
		process.env.PI_CODEX_IMAGE_RESPONSE_MODEL ||
		config.responseModel ||
		activeCodexImageModel ||
		DEFAULT_RESPONSE_MODEL
	);
}

function resolveBaseUrl(params: ToolParams, config: ExtensionConfig, ctxModel: { provider?: string; baseUrl?: string } | undefined): string {
	return (
		params.baseUrl ||
		process.env.PI_CODEX_IMAGE_BASE_URL ||
		config.baseUrl ||
		(ctxModel?.provider === PROVIDER ? ctxModel.baseUrl : undefined) ||
		DEFAULT_CODEX_BASE_URL
	);
}

function resolveQuality(params: ToolParams, config: ExtensionConfig): Quality {
	const value = params.quality || process.env.PI_CODEX_IMAGE_QUALITY || config.quality || DEFAULT_QUALITY;
	if (!isQuality(value)) throw new Error("quality must be low, medium, high, or auto.");
	return value;
}

function resolveSize(params: ToolParams, config: ExtensionConfig): string {
	return params.size || process.env.PI_CODEX_IMAGE_SIZE || config.size || DEFAULT_SIZE;
}

function validateImageToolOptions(params: ToolParams, imageModel: string, outputFormat: OutputFormat): void {
	if (imageModel === DEFAULT_IMAGE_MODEL && params.background === "transparent") {
		throw new Error(
			"gpt-image-2 does not support native transparent backgrounds. Use a flat chroma-key background in the prompt, then remove it locally with the bundled remove_chroma_key.py helper, or explicitly choose a model that supports native transparency.",
		);
	}
	if (imageModel === DEFAULT_IMAGE_MODEL && params.inputFidelity) {
		throw new Error("Do not set inputFidelity with gpt-image-2; image inputs already use high fidelity for this model.");
	}
	if (params.background === "transparent" && outputFormat === "jpeg") {
		throw new Error("Native transparent backgrounds require png or webp output.");
	}
}

function buildImageTool(params: ToolParams, config: ExtensionConfig, inputImages: InputImage[]): Record<string, unknown> {
	const imageModel = resolveImageModel(params, config);
	const outputFormat = resolveOutputFormat(params, config);
	validateImageToolOptions(params, imageModel, outputFormat);

	const tool: Record<string, unknown> = {
		type: "image_generation",
		model: imageModel,
		output_format: outputFormat,
		quality: resolveQuality(params, config),
		size: resolveSize(params, config),
		action: params.action || ((inputImages.length > 0 ? "auto" : "generate") as Action),
	};

	if (params.background) tool.background = params.background;
	if (params.inputFidelity) tool.input_fidelity = params.inputFidelity;
	if (params.moderation) tool.moderation = params.moderation;
	if (params.outputCompression !== undefined) tool.output_compression = params.outputCompression;
	if (params.partialImages !== undefined) tool.partial_images = params.partialImages;

	return tool;
}

function buildInputContent(prompt: string, inputImages: InputImage[]): Array<Record<string, unknown>> {
	const content: Array<Record<string, unknown>> = [
		{
			type: "input_text",
			text: [
				"Create exactly one image with the image_generation tool.",
				"Preserve exact requested text and constraints. Do not add watermarks unless explicitly requested.",
				inputImages.length > 0 ? "Use the attached image(s) as edit targets or visual references according to the prompt." : undefined,
				"Prompt:",
				prompt,
			]
				.filter(Boolean)
				.join("\n"),
		},
	];

	for (const image of inputImages) {
		content.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.base64}`,
		});
	}

	return content;
}

function buildRequestBody(params: ToolParams, config: ExtensionConfig, inputImages: InputImage[], responseModel: string): Record<string, unknown> {
	return {
		model: responseModel,
		stream: true,
		store: false,
		instructions:
			"You are an image-generation orchestrator. For the user's request, call the native image_generation tool exactly once. Do not answer with text instead of generating the image.",
		input: [
			{
				role: "user",
				content: buildInputContent(params.prompt, inputImages),
			},
		],
		tools: [buildImageTool(params, config, inputImages)],
		tool_choice: { type: "image_generation" },
		parallel_tool_calls: false,
	};
}

function errorFromCodexEvent(event: Record<string, unknown>): Error | undefined {
	if (event.type === "error") {
		return new Error(`Codex image generation error: ${String(event.message || event.code || JSON.stringify(event))}`);
	}
	if (event.type === "response.failed") {
		const response = event.response as { error?: { message?: unknown; code?: unknown } } | undefined;
		const message = response?.error?.message || response?.error?.code || "Codex image generation failed";
		return new Error(String(message));
	}
	return undefined;
}

function parseSseData(chunk: string): unknown[] {
	const data = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") return [];
	try {
		return [JSON.parse(data)];
	} catch {
		return [];
	}
}

function takeNextSseChunk(buffer: string): { chunk: string; rest: string } | undefined {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return undefined;
	if (crlf !== -1 && (lf === -1 || crlf < lf)) {
		return { chunk: buffer.slice(0, crlf), rest: buffer.slice(crlf + 4) };
	}
	return { chunk: buffer.slice(0, lf), rest: buffer.slice(lf + 2) };
}

async function parseCodexImageSse(
	response: Response,
	outputFormat: OutputFormat,
	onUpdate?: (result: { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: unknown }) => void,
	signal?: AbortSignal,
): Promise<CodexImageResult> {
	if (!response.body) throw new Error("Codex image generation response had no body.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let image: ImageGenerationItem | undefined;
	let responseId: string | undefined;
	let sawCompleted = false;

	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let nextChunk = takeNextSseChunk(buffer);
			while (nextChunk) {
				const { chunk, rest } = nextChunk;
				buffer = rest;

				for (const parsed of parseSseData(chunk)) {
					if (!parsed || typeof parsed !== "object") continue;
					const event = parsed as Record<string, unknown>;
					const eventError = errorFromCodexEvent(event);
					if (eventError) throw eventError;

					if (event.type === "response.created") {
						const response = event.response as { id?: unknown } | undefined;
						if (typeof response?.id === "string") responseId = response.id;
					} else if (event.type === "response.image_generation_call.partial_image") {
						const partial = event.partial_image_b64;
						if (typeof partial === "string" && partial.length > 0) {
							onUpdate?.({
								content: [
									{ type: "text", text: "Received a partial generated image preview..." },
									{ type: "image", data: partial, mimeType: mimeForOutputFormat(outputFormat) },
								],
							});
						}
					} else if (event.type === "response.output_item.done") {
						const item = event.item as ImageGenerationItem | undefined;
						if (item?.type === "image_generation_call" && typeof item.id === "string") {
							image = item;
						}
					} else if (event.type === "response.completed" || event.type === "response.done") {
						sawCompleted = true;
					}
				}

				nextChunk = takeNextSseChunk(buffer);
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Ignore cleanup errors.
		}
		reader.releaseLock();
	}

	if (!image) {
		throw new Error(sawCompleted ? "Codex completed without returning an image_generation_call." : "Codex stream ended before image generation completed.");
	}
	if (image.status === "failed") {
		throw new Error("Codex image generation failed.");
	}
	if (!image.result) {
		throw new Error(`Codex image generation returned no image data (status: ${image.status}).`);
	}

	return { image, responseId };
}

async function requestCodexImage(
	endpoint: string,
	credentials: ParsedCredentials,
	body: Record<string, unknown>,
	outputFormat: OutputFormat,
	signal?: AbortSignal,
	onUpdate?: (result: { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: unknown }) => void,
): Promise<CodexImageResult> {
	const requestId = `pi-codex-image-gen-${randomUUID()}`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.accessToken}`,
			"chatgpt-account-id": credentials.accountId,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
			"content-type": "application/json",
			"session_id": requestId,
			"x-client-request-id": requestId,
			"User-Agent": "pi-codex-image-gen",
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let message = text || response.statusText;
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
			message = parsed.error?.message || parsed.error?.code || message;
		} catch {
			// Keep raw text.
		}
		if (response.status === 401 || response.status === 403) {
			throw new Error(`Codex auth failed (${response.status}). Run /login for openai-codex again. ${message}`.trim());
		}
		throw new Error(`Codex image generation request failed (${response.status}): ${message}`);
	}

	return parseCodexImageSse(response, outputFormat, onUpdate, signal);
}

function resolveSaveMode(params: ToolParams, config: ExtensionConfig): SaveMode {
	const envMode = process.env.PI_CODEX_IMAGE_SAVE_MODE?.toLowerCase();
	const mode = params.save || (envMode && isSaveMode(envMode) ? envMode : undefined) || config.save || DEFAULT_SAVE_MODE;
	return isSaveMode(mode) ? mode : DEFAULT_SAVE_MODE;
}

function generatedFilename(prompt: string, imageCallId: string, outputFormat: OutputFormat): string {
	const stem = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	const safeStem = stem || "image";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${safeStem}-${timestamp}-${imageCallId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)}.${extensionForOutputFormat(outputFormat)}`;
}

async function writeImageFile(path: string, base64Data: string, overwrite: boolean): Promise<void> {
	await withFileMutationQueue(path, async () => {
		if (!overwrite && existsSync(path)) {
			throw new Error(`Refusing to overwrite existing image: ${path}`);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, Buffer.from(base64Data, "base64"));
	});
}

function normalizeOutputPath(cwd: string, outputPath: string, outputFormat: OutputFormat): string {
	const pathFormat = outputFormatFromPath(outputPath);
	if (pathFormat && pathFormat !== outputFormat) {
		throw new Error(`outputPath extension does not match outputFormat ${outputFormat}: ${outputPath}`);
	}
	let path = resolvePath(cwd, outputPath);
	if (!extname(path)) {
		path = `${path}.${extensionForOutputFormat(outputFormat)}`;
	}
	return path;
}

function isTmux(): boolean {
	return !!process.env.TMUX;
}

function shouldRenderTmuxKittyImage(): boolean {
	return isTmux() && process.env.PI_CODEX_IMAGE_TMUX_INLINE !== "0";
}

function tmuxWrap(sequence: string): string {
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function encodeKittyChunks(base64Data: string, columns: number, rows: number): string {
	const chunkSize = 4096;
	const params = [`a=T`, `f=100`, `q=2`, `c=${columns}`, `r=${rows}`];
	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + chunkSize);
		const isLast = offset + chunkSize >= base64Data.length;
		let sequence: string;
		if (isFirst && isLast) {
			sequence = `\x1b_G${params.join(",")};${chunk}\x1b\\`;
		} else if (isFirst) {
			sequence = `\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`;
			isFirst = false;
		} else if (isLast) {
			sequence = `\x1b_Gm=0;${chunk}\x1b\\`;
		} else {
			sequence = `\x1b_Gm=1;${chunk}\x1b\\`;
		}
		chunks.push(isTmux() ? tmuxWrap(sequence) : sequence);
		offset += chunkSize;
	}

	return chunks.join("");
}

function getPngDimensions(base64Data: string): { widthPx: number; heightPx: number } | undefined {
	try {
		const buffer = Buffer.from(base64Data, "base64");
		if (buffer.length < 24) return undefined;
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
		return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) };
	} catch {
		return undefined;
	}
}

function calculateRows(dimensions: { widthPx: number; heightPx: number }, widthCells: number): number {
	const cellWidthPx = 9;
	const cellHeightPx = 18;
	const targetWidthPx = widthCells * cellWidthPx;
	const scale = targetWidthPx / dimensions.widthPx;
	return Math.max(1, Math.ceil((dimensions.heightPx * scale) / cellHeightPx));
}

function imageFallback(mimeType: string | undefined, data: string | undefined): string {
	const dimensions = mimeType === "image/png" && data ? getPngDimensions(data) : undefined;
	const size = dimensions ? ` ${dimensions.widthPx}x${dimensions.heightPx}` : "";
	return `[Image: ${mimeType || "image/unknown"}${size}]`;
}

function wrapPlainLine(line: string, width: number): string[] {
	if (line.length <= width) return [line];
	const words = line.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!word) continue;
		if (current && current.length + word.length > width) {
			lines.push(current.trimEnd());
			current = word.trimStart();
		} else {
			current += word;
		}
		while (current.length > width) {
			lines.push(current.slice(0, width));
			current = current.slice(width);
		}
	}
	if (current) lines.push(current.trimEnd());
	return lines.length > 0 ? lines : [""];
}

function wrapPlainText(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	return text.replace(/\r/g, "").split("\n").flatMap((line) => wrapPlainLine(line, safeWidth));
}

function renderInlineKittyImage(base64Data: string, width: number): string[] {
	const maxWidthCells = Math.max(1, Math.min(width, getConfiguredImageWidthCells()));
	const dimensions = getPngDimensions(base64Data) || { widthPx: 800, heightPx: 600 };
	const rows = calculateRows(dimensions, maxWidthCells);
	const sequence = encodeKittyChunks(base64Data, maxWidthCells, rows);
	const lines = Array.from({ length: Math.max(0, rows - 1) }, () => "");
	lines.push(`${rows > 1 ? `\x1b[${rows - 1}A` : ""}${sequence}`);
	return lines;
}

function createResultRenderer(content: ToolContentBlock[], showImages: boolean) {
	return {
		render(width: number): string[] {
			const lines: string[] = [];
			const text = content
				.filter((block) => block.type === "text" && block.text)
				.map((block) => block.text || "")
				.join("\n");
			if (text) lines.push(...wrapPlainText(text, width));

			const piCanRenderImages = !!getCapabilities().images;
			const imageBlocks = content.filter((block) => block.type === "image");
			for (const image of imageBlocks) {
				if (showImages && shouldRenderTmuxKittyImage() && image.data && image.mimeType === "image/png") {
					if (lines.length > 0) lines.push("");
					lines.push(...renderInlineKittyImage(image.data, width));
				} else if (!showImages || !piCanRenderImages || shouldRenderTmuxKittyImage()) {
					lines.push(imageFallback(image.mimeType, image.data));
				}
			}

			return lines;
		},
	};
}

async function saveImage(params: ToolParams, config: ExtensionConfig, cwd: string, image: ImageGenerationItem, outputFormat: OutputFormat): Promise<SaveResult> {
	if (!image.result) throw new Error("Cannot save empty image result.");

	if (params.outputPath) {
		const path = normalizeOutputPath(cwd, params.outputPath, outputFormat);
		await writeImageFile(path, image.result, params.overwrite === true);
		return { mode: "outputPath", path };
	}

	const mode = resolveSaveMode(params, config);
	if (mode === "none") return { mode };

	let outputDir: string;
	if (mode === "project") {
		outputDir = join(cwd, ".pi", "generated-images", "codex-image-gen");
	} else if (mode === "global") {
		outputDir = join(getAgentDir(), "generated-images", "codex-image-gen");
	} else {
		const dir = params.saveDir || process.env.PI_CODEX_IMAGE_SAVE_DIR || config.saveDir;
		if (!dir || !dir.trim()) {
			throw new Error("save=custom requires saveDir, PI_CODEX_IMAGE_SAVE_DIR, or codex-image-gen.json saveDir.");
		}
		outputDir = resolvePath(cwd, dir);
	}

	const path = join(outputDir, generatedFilename(params.prompt, image.id, outputFormat));
	await writeImageFile(path, image.result, false);
	return { mode, path };
}

export default function codexImageGen(pi: ExtensionAPI) {
	pi.registerTool<typeof TOOL_PARAMS, ToolDetails>({
		name: "image_gen",
		label: "Image Gen",
		description:
			"Generate or edit one image via ChatGPT/Codex auth by calling the Codex Responses endpoint with the native image_generation tool. Defaults to gpt-image-2 and returns an inline image plus an optional saved file.",
		promptSnippet: "Generate or edit one raster image via Codex auth and the native image_generation tool.",
		promptGuidelines: [
			"Use image_gen for AI-generated bitmap assets such as photos, illustrations, mockups, sprites, textures, or raster variants.",
			"Use image_gen with model gpt-image-2 by default; do not ask the user for OPENAI_API_KEY because image_gen reuses openai-codex login credentials.",
			"For transparent images with image_gen and gpt-image-2, generate a flat chroma-key background first and remove it locally; gpt-image-2 does not support native transparent backgrounds.",
		],
		parameters: TOOL_PARAMS,
		renderShell: "self",
		renderResult(result, _options, _theme, context) {
			return createResultRenderer(result.content as ToolContentBlock[], context.showImages) as any;
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			const credentials = await getCodexCredentials(ctx);
			const inputImages = await loadInputImages(ctx.cwd, params.imagePaths);
			const outputFormat = resolveOutputFormat(params, config);
			const imageModel = resolveImageModel(params, config);
			const responseModel = resolveResponseModel(params, config, ctx.model);
			const baseUrl = resolveBaseUrl(params, config, ctx.model);
			const endpoint = resolveCodexResponsesUrl(baseUrl);
			const body = buildRequestBody(params, config, inputImages, responseModel);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Requesting image via ${PROVIDER}/${responseModel} using ${imageModel}...`,
					},
				],
				details: { provider: PROVIDER, endpoint, responseModel, imageModel },
			});

			const result = await requestCodexImage(endpoint, credentials, body, outputFormat, signal, onUpdate);
			const saveResult = await saveImage(params, config, ctx.cwd, result.image, outputFormat);
			const revisedPrompt = result.image.revised_prompt;
			const details: ToolDetails = {
				provider: PROVIDER,
				endpoint,
				responseModel,
				imageModel,
				imageCallId: result.image.id,
				status: result.image.status,
				revisedPrompt,
				savedPath: saveResult.path,
				saveMode: saveResult.mode,
				outputFormat,
				quality: resolveQuality(params, config),
				size: resolveSize(params, config),
				responseId: result.responseId,
			};

			const summary = [
				`Generated image via ${PROVIDER}/${responseModel} with ${imageModel}.`,
				`Image call: ${result.image.id}.`,
				revisedPrompt ? `Revised prompt: ${revisedPrompt}` : undefined,
				saveResult.path ? `Saved image to: ${saveResult.path}` : `Save mode: ${saveResult.mode}.`,
			]
				.filter(Boolean)
				.join(" ");

			return {
				content: [
					{ type: "text", text: summary },
					{ type: "image", data: result.image.result!, mimeType: mimeForOutputFormat(outputFormat) },
				],
				details,
			};
		},
	});
}
