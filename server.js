import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';
import { SmtpConfig } from '../models/smtp-config.model';
import { ToastService } from './toast.service';

@Injectable({
  providedIn: 'root'
})
export class SmtpConfigService {
  private apiUrl = '/api/smtp-config';

  constructor(
    private http: HttpClient,
    private toastService: ToastService
  ) {}

  getConfig(): Observable<SmtpConfig | null> {
    return this.http.get<SmtpConfig>(this.apiUrl).pipe(
      catchError(error => {
        if (error.status === 401) {
          this.toastService.show('Admin authentication required', 'error');
        } else {
          this.toastService.show('Failed to load SMTP configuration', 'error');
        }
        return of(null);
      })
    );
  }

  saveConfig(config: SmtpConfig): Observable<any> {
    return this.http.post(this.apiUrl, config).pipe(
      catchError(error => {
        if (error.status === 401) {
          this.toastService.show('Admin authentication required', 'error');
        } else {
          this.toastService.show('Failed to save SMTP configuration', 'error');
        }
        throw error;
      })
    );
  }

  testConnection(config: SmtpConfig): Observable<any> {
    return this.http.post(`${this.apiUrl}/test`, config).pipe(
      catchError(error => {
        this.toastService.show('SMTP connection test failed', 'error');
        throw error;
      })
    );
  }
}

