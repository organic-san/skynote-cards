import path from 'node:path';

/** 執行時設定。全部有預設值，本機不必給環境變數就能跑起來。 */
export interface Config {
  corpusPath: string;
  indexPath: string;
  port: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const corpusPath = path.resolve(env.CORPUS_PATH ?? './corpus-dev');
  return {
    corpusPath,
    // 索引放在語料庫 repo 外，不進版控。
    indexPath: path.resolve(env.INDEX_PATH ?? path.join(corpusPath, '..', 'index.db')),
    port: Number(env.PORT ?? 3000),
    gitAuthorName: env.GIT_AUTHOR_NAME ?? 'append-cards',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? 'append-cards@localhost',
  };
}
