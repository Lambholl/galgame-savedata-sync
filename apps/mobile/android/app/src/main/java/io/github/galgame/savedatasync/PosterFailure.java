package io.github.galgame.savedatasync;

/** 封面操作的错误，带稳定的错误码和不含本机路径的消息；原始异常留作 cause。 */
final class PosterFailure extends Exception {

  final String code;

  PosterFailure(String code, String message) {
    super(message);
    this.code = code;
  }

  PosterFailure(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }
}
