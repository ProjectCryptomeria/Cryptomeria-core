import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DockerService, buildEmitter } from './services/DockerService.js'

const app = new Hono()

// WebSocketのセットアップ
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

// CORS設定
app.use('/*', cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], // フロントエンドのURL
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}))

// --- API Routes ---

app.get('/', (c) => {
  return c.text('RaidChain WebUI Backend is Running!')
})

// ビルドトリガーAPI
app.post('/api/v1/infra/images/build', async (c) => {
  try {
    const body = await c.req.json();
    const target = body.target as 'datachain' | 'metachain' | 'relayer';

    // 非同期でビルドを開始（レスポンスを待たせない）
    DockerService.buildImage(target).catch(err => console.error(err));

    return c.json({ message: `Build started for ${target}` });
  } catch (e) {
    return c.json({ error: 'Invalid request' }, 400);
  }
})

// --- WebSocket Routes ---

app.get('/ws/infra/build-log', upgradeWebSocket((c) => {
  return {
    onOpen(_event, ws) {
      console.log('WS: Client connected');
      // ログイベントを購読してWSに転送
      const listener = (data: string) => {
        ws.send(data);
      };
      buildEmitter.on('log', listener);

      // 切断時に購読解除するためのクリーンアップ関数を保持できないため
      // closeイベントで解除するようにする（下記参照）
      (ws as any).listener = listener;
    },
    onClose(_event, ws) {
      console.log('WS: Client disconnected');
      const listener = (ws as any).listener;
      if (listener) {
        buildEmitter.off('log', listener);
      }
    },
  }
}))

const port = 3000
console.log(`Server is running on port ${port}`)

// サーバー起動（injectWebSocketを使用）
const server = serve({
  fetch: app.fetch,
  port,
  hostname: '0.0.0.0'
})
injectWebSocket(server)