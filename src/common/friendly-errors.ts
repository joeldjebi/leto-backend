import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, HttpStatus, Logger, ValidationError } from '@nestjs/common';
import { Response } from 'express';

/** Message d'erreur générique, compréhensible par tous (jamais de détail technique côté utilisateur) */
export const GENERIC_ERROR = 'Une erreur est survenue. Réessayez dans un instant.';
export const INVALID_FORM = 'Certaines informations sont manquantes ou invalides. Vérifiez et réessayez.';

/** Messages par défaut de class-validator (anglais technique : « phone must be a string ») */
const technical = (m: string) =>
  /\b(must|should|cannot|property|is not allowed|each value|unexpected|json|token|undefined|null|error|exception|failed|invalid input|violates|ECONN|ETIMEDOUT)\b/i.test(m) ||
  /^(Bad Request|Not Found|Internal Server Error|Unauthorized|Forbidden|Conflict|Payload Too Large|Too Many Requests)$/i.test(m);

const flatten = (errors: ValidationError[]): string[] =>
  errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flatten(e.children ?? [])]);

/** Validation : on garde les messages rédigés en français dans les DTO, sinon un message générique */
export function validationExceptionFactory(errors: ValidationError[]) {
  const readable = [...new Set(flatten(errors).filter((m) => !technical(m)))];
  return new BadRequestException(readable.length ? readable : INVALID_FORM);
}

/**
 * Toutes les erreurs passent ici : les messages prévus pour l'utilisateur (en français) sont conservés,
 * les erreurs internes, routes inconnues et messages techniques sont remplacés par un message clair.
 */
@Catch()
export class FriendlyErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Erreurs');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    if (!res || typeof res.status !== 'function') return; // temps réel (WebSocket) : géré par Nest
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = GENERIC_ERROR;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === 'string' ? body : (body as { message?: string | string[] })?.message;
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((m) => m && !technical(m));
      if (status >= 500) message = GENERIC_ERROR;
      else if (status === 404 && !list.length) message = 'Page ou service introuvable.';
      else if (status === 413) message = 'Le fichier est trop volumineux.';
      else if (status === 429) message = 'Trop de tentatives. Patientez un instant puis réessayez.';
      else if (status === 401 && (!list.length || list.every((m) => m === 'Unauthorized'))) message = 'Votre session a expiré. Reconnectez-vous.';
      else if (status === 403 && (!list.length || list.every((m) => m === 'Forbidden' || m === 'Forbidden resource'))) message = 'Vous n’avez pas accès à cette action.';
      else if (list.length) message = list.length === 1 ? list[0] : list;
      else message = status === 400 ? INVALID_FORM : GENERIC_ERROR;
      if (status >= 500) this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(exception instanceof Error ? exception.message : String(exception), exception instanceof Error ? exception.stack : undefined);
    }
    res.status(status).json({ statusCode: status, message });
  }
}
