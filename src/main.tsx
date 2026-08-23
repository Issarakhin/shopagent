import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import TelegramShopApp from './TelegramShopApp.tsx';
import { hasTelegramLaunchContext, waitForTelegramWebApp } from './telegram-webapp.ts';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found.');
const root = createRoot(rootElement);

function render(app: React.ReactNode) {
  root.render(<StrictMode>{app}</StrictMode>);
}

async function bootstrap() {
  // A /telegram URL is always the Mini App, even before Telegram JS exposes
  // initData. This prevents the normal site's Sign In UI from flashing.
  if (window.location.pathname.startsWith('/telegram')) {
    render(<TelegramShopApp />);
    return;
  }

  // Telegram Desktop may open the configured root domain and initialize the
  // Telegram bridge a moment after this module begins. Give it a short chance
  // before deciding that this is the normal public website.
  if (hasTelegramLaunchContext()) {
    render(<TelegramShopApp />);
    return;
  }

  await waitForTelegramWebApp(1200);

  if (hasTelegramLaunchContext()) {
    render(<TelegramShopApp />);
    return;
  }

  render(<App />);
}

void bootstrap();
