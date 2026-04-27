/*
 * Copyright (c) 2026 Sapience AI Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { render } from 'preact';
import { App } from './App';
import './styles/reset.css';
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/charts.css';

render(<App />, document.getElementById('app')!);
