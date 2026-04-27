/**
 * Typed error hierarchy for the knowledge hub backend.
 * All errors extend KnowledgeHubError so middleware can handle them uniformly.
 */

export class KnowledgeHubError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'KnowledgeHubError';
    this.statusCode = statusCode;
    this.code = code;
    // V8-specific stack trace capture
    const ErrorWithCapture = Error as typeof Error & {
      captureStackTrace?: (target: object, ctor: unknown) => void;
    };
    ErrorWithCapture.captureStackTrace?.(this, this.constructor);
  }
}

export class NotFoundError extends KnowledgeHubError {
  public constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class UnauthorisedError extends KnowledgeHubError {
  public constructor(detail?: string) {
    super(detail ?? 'Unauthorised', 401, 'UNAUTHORISED');
    this.name = 'UnauthorisedError';
  }
}

export class ForbiddenError extends KnowledgeHubError {
  public constructor(detail?: string) {
    super(detail ?? 'Forbidden', 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends KnowledgeHubError {
  public readonly fields: Record<string, string>;

  public constructor(message: string, fields: Record<string, string> = {}) {
    super(message, 422, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

export class IntegrationError extends KnowledgeHubError {
  public readonly source: string;

  public constructor(source: string, detail: string) {
    super(`Integration error [${source}]: ${detail}`, 502, 'INTEGRATION_ERROR');
    this.name = 'IntegrationError';
    this.source = source;
  }
}

export class BlobStorageError extends KnowledgeHubError {
  public constructor(operation: string, detail: string) {
    super(`Blob storage error during ${operation}: ${detail}`, 502, 'BLOB_STORAGE_ERROR');
    this.name = 'BlobStorageError';
  }
}

export class AiError extends KnowledgeHubError {
  public constructor(detail: string) {
    super(`AI layer error: ${detail}`, 502, 'AI_ERROR');
    this.name = 'AiError';
  }
}

export class WriteActionNotConfirmedError extends KnowledgeHubError {
  public constructor() {
    super('Write action requires explicit user confirmation before execution', 409, 'WRITE_ACTION_NOT_CONFIRMED');
    this.name = 'WriteActionNotConfirmedError';
  }
}

export class ConfigurationError extends KnowledgeHubError {
  public constructor(variable: string) {
    super(`Missing required configuration: ${variable}`, 500, 'CONFIGURATION_ERROR');
    this.name = 'ConfigurationError';
  }
}
