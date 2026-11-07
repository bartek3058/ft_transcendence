import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Matches, ValidateBy } from 'class-validator';
import { codePointLength, DESCRIPTION_MAX_LENGTH, TITLE_LENGTH, TOURNAMENT_SIZES } from '../tournament-rules';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

function TextLength(min: number, max: number) {
  return ValidateBy({
    name: 'textLength',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string') return false;
        const length = codePointLength(value);
        return length >= min && length <= max;
      },
    },
  });
}

// Full date-time with an explicit offset: a bare date or local time is ambiguous.
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export class CreateTournamentDto {
  @Transform(trim)
  @IsString()
  @TextLength(TITLE_LENGTH.min, TITLE_LENGTH.max)
  @Matches(/^[^\p{Cc}]*$/u) // no control characters
  title!: string;

  // Empty after trimming is stored as null by the service.
  @IsOptional()
  @Transform(trim)
  @IsString()
  @TextLength(0, DESCRIPTION_MAX_LENGTH)
  @Matches(/^[^\p{Cc}]*$/u) // no control characters (the frontend lobby shows one line)
  description?: string | null;

  @IsInt()
  @IsIn(TOURNAMENT_SIZES)
  maxParticipants!: number;

  @IsString()
  @Matches(DATE_TIME_WITH_OFFSET)
  @IsISO8601({ strict: true }) // also rejects impossible dates such as 2030-02-30
  registrationDeadline!: string;
}
