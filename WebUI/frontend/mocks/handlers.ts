import { MockServer } from '../services/mockBackend';

const { http, HttpResponse, delay } = window.MockServiceWorker;

export const handlers = [
  // --- Deployment Layer ---
  http.post('/api/deployment/build', async () => {
    await delay(500);
    const result = await MockServer.buildImage();
    return HttpResponse.json(result, { status: 202 });
  }),

  http.post('/api/deployment/scale', async ({ request }: any) => {
    const { replicaCount } = await request.json();
    await MockServer.scaleCluster(replicaCount);
    return HttpResponse.json({ status: 'accepted' }, { status: 202 });
  }),

  http.delete('/api/deployment/reset', async () => {
    await MockServer.scaleCluster(0);
    return HttpResponse.json({ success: true });
  }),

  // --- Economy Layer ---
  http.get('/api/economy/users', async () => {
    const data = await MockServer.getUsers();
    return HttpResponse.json(data);
  }),

  http.post('/api/economy/user', async () => {
    // 簡易実装: 引数なしで作成
    const newUser = await MockServer.createUser();
    return HttpResponse.json(newUser, { status: 201 });
  }),

  http.delete('/api/economy/user/:id', async ({ params }: any) => {
    const { id } = params;
    await MockServer.deleteUser(id);
    return HttpResponse.json({ success: true });
  }),

  http.post('/api/economy/faucet', async ({ request }: any) => {
    const { targetId, amount } = await request.json();
    try {
      const result = await MockServer.faucet(targetId, amount || 100);
      return HttpResponse.json(result);
    } catch (e) {
      return HttpResponse.json({ error: 'Faucet failed' }, { status: 400 });
    }
  }),

  // --- Experiment Layer ---
  http.post('/api/experiment/estimate', async ({ request }: any) => {
    const config = await request.json();
    // 簡易試算ロジック
    const cost = (config.dataSizeMB || 0) * 2.5 + (config.targetChains?.length || 0) * 100;
    return HttpResponse.json({ cost, isBudgetSufficient: true });
  }),

  http.post('/api/experiment/run', async ({ request }: any) => {
    const { scenarios } = await request.json();
    const result = await MockServer.runExperiment(scenarios);
    return HttpResponse.json(result, { status: 202 });
  }),

  // --- Library Layer ---
  http.get('/api/library/results', async () => {
    const results = await MockServer.getResults();
    return HttpResponse.json(results);
  }),
  
  http.delete('/api/library/results/:id', async ({ params }: any) => {
     const { id } = params;
     await MockServer.deleteResult(id);
     return HttpResponse.json({ success: true });
  })
];