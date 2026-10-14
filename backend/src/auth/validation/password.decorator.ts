import { registerDecorator } from 'class-validator';
import { isValidPassword } from './input-rules';

export function IsPassword(minimum: number): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({
    name: 'isPassword',
    target: target.constructor,
    propertyName: String(propertyKey),
    validator: { validate: (value: unknown) => isValidPassword(value, minimum) },
  });
}
