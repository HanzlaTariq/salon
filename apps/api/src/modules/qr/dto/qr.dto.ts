import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { POSTER_SIZES, POSTER_THEMES, PosterSize, PosterTheme, QR_IMAGE_FORMATS, QR_LIMITS, QrImageFormat } from '../qr.types';

const flag = () => Transform(({ value }) => value === '1' || value === 'true' || value === true);

/** GET /salons/mine/qr/image */
export class QrImageQuery {
  @IsOptional() @IsIn(QR_IMAGE_FORMATS) format?: QrImageFormat;
  /** PNG width in pixels (ignored for SVG). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(QR_LIMITS.minPx) @Max(QR_LIMITS.maxPx) size?: number;
  /** 1 = send as a download (Content-Disposition: attachment). */
  @IsOptional() @flag() download?: boolean;
}

/** GET /salons/mine/qr/poster */
export class PosterQuery {
  @IsOptional() @IsIn(POSTER_SIZES) size?: PosterSize;
  @IsOptional() @IsIn(POSTER_THEMES) theme?: PosterTheme;
  @IsOptional() @flag() download?: boolean;
}
