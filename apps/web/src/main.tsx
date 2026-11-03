import { exchangeBrowserSession } from '@asana-cli/service-client';
import { DependencyGraphView } from './app/DependencyGraphView';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { createStore } from 'jotai/vanilla';
import { App } from './app/App';
import { createHttpClient } from './api/client';
import { createDemoClient } from './api/demo-client';
import { createBoardController } from './state/controller';
import './styles/tokens.css';
import './styles/app.css';

await exchangeBrowserSession().catch(() => undefined);
const store = createStore();
const client = new URLSearchParams(window.location.search).get('demo') === '1'
  ? createDemoClient() : createHttpClient();
const controller = createBoardController(store, client);
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
const params = new URLSearchParams(location.search);
const content = params.get('view') === 'dependencies' ? <DependencyGraphView root={params.get('task') ?? ''} /> : <App controller={controller} />;
createRoot(root).render(<StrictMode><Provider store={store}>{content}</Provider></StrictMode>);
