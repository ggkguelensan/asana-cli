import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { boardAtom, connectedAtom, connectionAtom, stopDialogAtom, themeAtom } from '../state/atoms';
import { Icon } from './Icon';

const connectionLabels = {
  connecting: 'Подключаемся', live: 'На связи', reconnecting: 'Восстанавливаем связь',
  offline: 'Нет связи', unauthorized: 'Нужна авторизация', invalid_response: 'Несовместимый сервис', stopped: 'Сервис остановлен',
};

function StopServiceButton() {
  const board = useAtomValue(boardAtom);
  const connected = useAtomValue(connectedAtom);
  const openStop = useSetAtom(stopDialogAtom);
  if (!board?.capabilities.stop) return null;
  return <button className="icon-button" disabled={!connected} aria-label="Остановить сервис"
    title="Остановить сервис" onClick={() => openStop(true)}><Icon name="stop" /></button>;
}
function useTheme(theme: 'system' | 'light' | 'dark'): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system'
      ? (media.matches ? 'dark' : 'light') : theme; };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
export function BoardHeader({ demo }: { demo: boolean }) {
  const board = useAtomValue(boardAtom);
  const connection = useAtomValue(connectionAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  useTheme(theme);
  const themes = ['system', 'light', 'dark'] as const;
  const themeNames = { system: 'системная', light: 'светлая', dark: 'тёмная' };
  return <header className="page-header">
    <div className="header-nav">
      <span className="brand"><span className="brand-mark"><Icon name="grid" /></span>asana-cli<span className="brand-divider">/</span><span className="workspace-name">{board?.workspace ?? 'Рабочая доска'}</span></span>
      <div className="header-controls">
        <span className={`connection connection-${connection}`} role="status"><span />{demo ? 'Пример' : connectionLabels[connection]}</span>
        <button className="icon-button" aria-label={`Тема: ${themeNames[theme]}`} title={`Тема: ${themeNames[theme]}`}
          onClick={() => setTheme(themes[(themes.indexOf(theme) + 1) % themes.length])}><Icon name="sun" /></button>
        <StopServiceButton />
      </div>
    </div>
    <div className="page-title"><div><h1>Окна задач<span className="title-dot">.</span></h1>
      <p>Задачи, решения и ревью в одном месте.</p></div>
      <span className="page-eyebrow">ВАША РАБОЧАЯ ДОСКА</span>
    </div>
  </header>;
}
