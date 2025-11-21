export {};

declare global {
  interface Window {
    MockServiceWorker: {
      setupWorker: (...handlers: any[]) => {
        start: (options?: any) => Promise<void>;
      };
      http: {
        get: (path: string, resolver: any) => any;
        post: (path: string, resolver: any) => any;
        delete: (path: string, resolver: any) => any;
        put: (path: string, resolver: any) => any;
      };
      HttpResponse: {
        json: (body: any, options?: { status?: number }) => any;
      };
      delay: (ms?: number) => Promise<void>;
    };
  }
}