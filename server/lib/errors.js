'use strict';

class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

const badRequest = (message = 'Некорректный запрос.', code = 'bad_request') => new ApiError(400, code, message);
const unauthorized = (message = 'Требуется вход в систему.') => new ApiError(401, 'unauthorized', message);
const forbidden = (message = 'Недостаточно прав для этого действия.', code = 'forbidden') => new ApiError(403, code, message);
const notFound = (message = 'Запрошенные данные не найдены.') => new ApiError(404, 'not_found', message);
const conflict = (message, code = 'conflict') => new ApiError(409, code, message);

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict };
