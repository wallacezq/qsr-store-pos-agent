/*
 * Copyright (c) 2026 Intel Corporation
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, retry, throwError, timer } from 'rxjs';
import { ToastService } from './toast.service';

// Surface HTTP 429s with a transient toast and transparently retry idempotent
// GETs (honouring Retry-After) instead of failing silently.
export const rateLimitInterceptor: HttpInterceptorFn = (req, next) => {
  const toast = inject(ToastService);
  return next(req).pipe(
    retry({
      count: req.method === 'GET' ? 2 : 0,
      delay: (err) => {
        if (err instanceof HttpErrorResponse && err.status === 429) {
          toast.show('Server busy (rate limited) — retrying…', 'warn');
          const retryAfter = Number(err.headers?.get('Retry-After')) || 2;
          return timer(retryAfter * 1000);
        }
        return throwError(() => err);
      },
    }),
    catchError((err) => {
      if (err instanceof HttpErrorResponse && err.status === 429) {
        toast.show('Too many requests — please wait a moment and retry.', 'error');
      }
      return throwError(() => err);
    }),
  );
};
