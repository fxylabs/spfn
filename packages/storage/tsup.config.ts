import { defineConfig } from 'tsup';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

export default defineConfig({
    entry: {
        'shared/index': 'src/shared/index.ts',
        'server/index': 'src/server/index.ts',
        'server/keys': 'src/server/keys.ts',
        'server/local.provider': 'src/server/local.provider.ts',
        'server/gcs.provider': 'src/server/gcs.provider.ts',
        'server/s3.provider': 'src/server/s3.provider.ts',
    },
    format: ['esm'],
    esbuildPlugins: [recordMetafile('main')],
    dts: true,
    sourcemap: true,
    clean: true,
    // shared/index의 오류 클래스가 엔트리마다 복제되면 `error instanceof StorageObjectNotFoundError`가
    // 엔트리를 가로지를 때 false가 된다. 코드 분할로 공용 청크를 하나만 두어 클래스 동일성을 지킨다.
    splitting: true,
    external: [
        '@aws-sdk/client-s3',
        '@aws-sdk/s3-request-presigner',
        '@google-cloud/storage',
    ],
});
