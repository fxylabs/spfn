import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    reactCompiler: true,

    async rewrites()
    {
        return [
            {
                // Provider callbacks must return to the web origin so the host-only
                // OAuth CSRF cookie is present. Next forwards the request to SPFN.
                source: '/_auth/:path*',
                destination: `${process.env.SPFN_API_URL || 'http://localhost:8890'}/_auth/:path*`,
            },
            {
                // Android verifies the Sign in with Apple App Link against this
                // file, which SPFN serves from SPFN_AUTH_ANDROID_*. It accepts a
                // 200 with no redirect only.
                source: '/.well-known/assetlinks.json',
                destination: `${process.env.SPFN_API_URL || 'http://localhost:8890'}/.well-known/assetlinks.json`,
            },
        ];
    },

    webpack(config)
    {
        // SVGR: Import SVG as React components
        const fileLoaderRule = (config.module.rules as any[])
            .find((rule: any) => Array.isArray(rule.oneOf))
            ?.oneOf.find((rule: any) => rule.test?.test?.('.svg'));

        if (fileLoaderRule) 
        {
            fileLoaderRule.exclude = /\.svg$/i;
        }

        config.module.rules.unshift({
            test: /\.svg$/i,
            use: ['@svgr/webpack'],
        });

        return config;
    },
    turbopack: {
        rules: {
            '*.svg': {
                loaders: ['@svgr/webpack'],
                as: '*.js',
            },
        },
    },
};

export default nextConfig;
