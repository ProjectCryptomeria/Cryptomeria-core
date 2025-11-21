import { handlers } from './handlers';

const { setupWorker } = window.MockServiceWorker;

export const worker = setupWorker(...handlers);