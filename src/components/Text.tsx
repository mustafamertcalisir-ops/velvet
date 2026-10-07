import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { color } from '@/design/tokens';
import { maxFontScale, type as typeScale } from '@/design/typography';

export type TextVariant = keyof typeof typeScale;
type Tone = 'primary' | 'secondary' | 'tertiary' | 'error' | 'inverse';

const tones: Record<Tone, string> = {
  primary: color.text,
  secondary: color.textSecondary,
  tertiary: color.textTertiary,
  error: color.error,
  inverse: color.onPrimary,
};

const displayVariants: TextVariant[] = ['display', 'headline', 'answer'];

export function Text({
  variant = 'body',
  tone = 'primary',
  style,
  ...rest
}: TextProps & { variant?: TextVariant; tone?: Tone }) {
  return (
    <RNText
      maxFontSizeMultiplier={displayVariants.includes(variant) ? maxFontScale.display : maxFontScale.body}
      {...rest}
      style={[typeScale[variant] as TextStyle, { color: tones[tone] }, style]}
    />
  );
}
