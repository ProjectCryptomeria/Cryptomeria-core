import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

/**
 * アプリケーションのエントリーポイント
 * index.htmlのroot要素に対してReactアプリケーションをマウントします。
 */

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// MSWの待機を削除し、即座にレンダリングを開始
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);