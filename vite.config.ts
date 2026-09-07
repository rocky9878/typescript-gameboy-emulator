import inertia from "@inertiajs/vite";
import { wayfinder } from "@laravel/vite-plugin-wayfinder";
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import laravel from 'laravel-vite-plugin';
import { defineConfig, loadEnv } from 'vite';


export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');

    return {
        server: {
            host: '0.0.0.0',
            hmr: {
                host: '127.0.0.1',
            },
        },
        ssr: {
            optimizeDeps: {
                include: ['lodash/omit'],
            },
            noExternal: [
                'lodash/omit',
            ],
        },
        plugins: [
            laravel({
                input: ['resources/js/app.ts' , 'resources/css/app.css'],
                refresh: true,
            }),
            vue({
                template: {
                    transformAssetUrls: {
                        base: null,
                        includeAbsolute: false,
                    },
                },
            }),
            inertia(),
            tailwindcss(),
            wayfinder({
                formVariants: true,
                command: env.WAYFINDER_COMMAND
            }),
        ],
    }
});
