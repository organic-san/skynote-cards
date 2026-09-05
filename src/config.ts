import path from 'node:path';
import { DEFAULT_EDIT_WINDOW_HOURS } from './domain/rules.ts';

/** 執行時設定。全部有預設值，本機不必給環境變數就能跑起來。 */
export interface Config {
  corpusPath: string;
  indexPath: string;
  port: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** 反芻期長度，毫秒（R5）。小時進、毫秒出，只在這裡換算一次。 */
  editWindowMs: number;
}

/**
 * 亂填的值退回預設，不讓它變成 NaN。
 * NaN 會讓每一張卡都「已過期」——一個設定的手誤靜悄悄關掉整個反芻期，
 * 而畫面上只會看到「編輯」按鈕不見了。
 */
function editWindowHours(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EDIT_WINDOW_HOURS;
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
    editWindowMs: editWindowHours(env.EDIT_WINDOW_HOURS) * 60 * 60 * 1000,
  };
}
