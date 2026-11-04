/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private darkMode = signal(false);

  currentTheme = () => this.darkMode() ? 'dark-theme' : 'light-theme';
  isDark = () => this.darkMode();

  constructor() {
    const saved = localStorage.getItem('pos-theme');
    if (saved === 'dark') {
      this.darkMode.set(true);
    }
    this.applyBodyClass();
  }

  toggleTheme(): void {
    this.darkMode.update(v => !v);
    localStorage.setItem('pos-theme', this.darkMode() ? 'dark' : 'light');
    this.applyBodyClass();
  }

  // Mirror the theme class onto <body> so CDK overlay panels (menus, select
  // dropdowns) that attach outside the app wrapper are themed too.
  private applyBodyClass(): void {
    const body = document.body;
    body.classList.toggle('dark-theme', this.darkMode());
    body.classList.toggle('light-theme', !this.darkMode());
  }
}
