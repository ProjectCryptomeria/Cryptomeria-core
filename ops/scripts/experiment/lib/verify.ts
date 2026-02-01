import { CONFIG } from "./config.ts";

/**
 * ページ到達性と整合性の検証
 */
export async function checkRender(project: string, version: string, path: string) {
  const url = `${CONFIG.RENDER_URL}/${project}/${version}/${path}`;
  const res = await fetch(url);
  return res.status === 200;
}