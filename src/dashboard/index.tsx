import { render } from 'preact';
import { App } from './App';
import './styles/reset.css';
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/charts.css';

render(<App />, document.getElementById('app')!);
