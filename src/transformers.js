import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { Buffer } from 'node:buffer';

import { pipeline, env, RawImage } from 'sillytavern-transformers';
import { getConfigValue } from './util.js';
import { serverDirectory } from './server-directory.js';

configureTransformers();

function configureTransformers() {
    // Limit the number of threads to 1 to avoid issues on Android
    env.backends.onnx.wasm.numThreads = 1;
    // Use WASM from a local folder to avoid CDN connections
    env.backends.onnx.wasm.wasmPaths = path.join(serverDirectory, 'node_modules', 'sillytavern-transformers', 'dist') + path.sep;
}

/**
 * @typedef {object} TaskConfig
 * @property {string} defaultModel - Default model ID
 * @property {any} pipeline - Instantiated pipeline or null
 * @property {string} configField - Configuration key in config.yaml
 * @property {boolean} quantized - Whether quantization is enabled
 * @property {string} [currentModel] - Active loaded model identifier
 * @property {Promise<any>|null} [pipelinePromise] - In-flight initialization promise
 */

/**
 * @type {Record<string, TaskConfig>}
 */
const tasks = {
    'text-classification': {
        defaultModel: 'Cohee/distilbert-base-uncased-go-emotions-onnx',
        pipeline: null,
        configField: 'extensions.models.classification',
        quantized: true,
    },
    'image-to-text': {
        defaultModel: 'Xenova/vit-gpt2-image-captioning',
        pipeline: null,
        configField: 'extensions.models.captioning',
        quantized: true,
    },
    'feature-extraction': {
        defaultModel: 'Xenova/all-mpnet-base-v2',
        pipeline: null,
        configField: 'extensions.models.embedding',
        quantized: true,
    },
    'automatic-speech-recognition': {
        defaultModel: 'Xenova/whisper-small',
        pipeline: null,
        configField: 'extensions.models.speechToText',
        quantized: true,
    },
    'text-to-speech': {
        defaultModel: 'Xenova/speecht5_tts',
        pipeline: null,
        configField: 'extensions.models.textToSpeech',
        quantized: false,
    },
};

/**
 * Gets a RawImage object from a base64-encoded image.
 * @param {string} image Base64-encoded image
 * @returns {Promise<RawImage|null>} Object representing the image
 */
export async function getRawImage(image) {
    try {
        const buffer = Buffer.from(image, 'base64');
        const byteArray = new Uint8Array(buffer);
        const blob = new Blob([byteArray]);

        const rawImage = await RawImage.fromBlob(blob);
        return rawImage;
    } catch {
        return null;
    }
}

/**
 * Gets the model to use for a given transformers.js task.
 * @param {string} task The task to get the model for
 * @returns {string} The model to use for the given task
 */
function getModelForTask(task) {
    const defaultModel = tasks[task].defaultModel;

    try {
        const model = getConfigValue(tasks[task].configField, null);
        return model || defaultModel;
    } catch (error) {
        console.warn('Failed to read config.yaml, using default classification model.');
        return defaultModel;
    }
}

async function migrateCacheToDataDir() {
    const oldCacheDir = path.join(process.cwd(), 'cache');
    const newCacheDir = path.join(globalThis.DATA_ROOT, '_cache');

    if (!fs.existsSync(newCacheDir)) {
        fs.mkdirSync(newCacheDir, { recursive: true });
    }

    if (fs.existsSync(oldCacheDir) && fs.statSync(oldCacheDir).isDirectory()) {
        const files = fs.readdirSync(oldCacheDir);

        if (files.length === 0) {
            return;
        }

        console.log('Migrating model cache files to data directory. Please wait...');

        for (const file of files) {
            try {
                const oldPath = path.join(oldCacheDir, file);
                const newPath = path.join(newCacheDir, file);
                fs.cpSync(oldPath, newPath, { recursive: true, force: true });
                fs.rmSync(oldPath, { recursive: true, force: true });
            } catch (error) {
                console.warn('Failed to migrate cache file. The model will be re-downloaded.', error);
            }
        }
    }
}

/**
 * Gets the transformers.js pipeline for a given task.
 * @param {import('sillytavern-transformers').PipelineType} task The task to get the pipeline for
 * @param {string} forceModel The model to use for the pipeline, if any
 * @returns {Promise<import('sillytavern-transformers').Pipeline>} The transformers.js pipeline
 */
export async function getPipeline(task, forceModel = '') {
    await migrateCacheToDataDir();

    const targetModel = forceModel || getModelForTask(task);

    if (tasks[task].pipeline) {
        if (tasks[task].currentModel === targetModel) {
            return tasks[task].pipeline;
        }
        console.log('Disposing transformers.js pipeline for task', task, 'with model', tasks[task].currentModel);
        await tasks[task].pipeline.dispose();
        tasks[task].pipeline = null;
        tasks[task].pipelinePromise = null;
    }

    if (tasks[task].pipelinePromise && tasks[task].currentModel === targetModel) {
        return tasks[task].pipelinePromise;
    }

    const cacheDir = path.join(globalThis.DATA_ROOT, '_cache');
    const localOnly = !getConfigValue('extensions.models.autoDownload', true, 'boolean');
    console.log('Initializing transformers.js pipeline for task', task, 'with model', targetModel);

    tasks[task].currentModel = targetModel;
    tasks[task].pipelinePromise = (async () => {
        try {
            const instance = await pipeline(task, targetModel, {
                cache_dir: cacheDir,
                quantized: tasks[task].quantized ?? true,
                local_files_only: localOnly,
            });
            tasks[task].pipeline = instance;
            return instance;
        } finally {
            tasks[task].pipelinePromise = null;
        }
    })();

    // @ts-ignore
    return tasks[task].pipelinePromise;
}

export default {
    getRawImage,
    getPipeline,
};
