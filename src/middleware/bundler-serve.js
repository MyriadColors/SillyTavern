import esbuild from 'esbuild';
import path from 'node:path';
import { serverDirectory } from '../server-directory.js';

export default function getBundlerServeMiddleware() {
    /**
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    function devMiddleware(req, res, next) {
        if (req.method === 'GET' && req.path === '/lib.js') {
            return res.sendFile('lib.js', { root: path.join(serverDirectory, 'public', 'dist') });
        }
        next();
    }

    devMiddleware.runCompiler = async () => {
        console.log();
        console.log('Compiling frontend libraries with Esbuild...');

        const startTime = Date.now();
        await esbuild.build({
            entryPoints: [path.join(serverDirectory, 'public/lib.js')],
            bundle: true,
            minify: true,
            format: 'esm',
            outfile: path.join(serverDirectory, 'public/dist/lib.js'),
        });

        console.log(`Esbuild compiled successfully in ${Date.now() - startTime} ms`);
        console.log();
    };

    return devMiddleware;
}
