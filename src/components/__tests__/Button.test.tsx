/**
 * The shared Button's disabled state is a real accessibility state — not
 * only opacity: it is exposed to assistive technology and ignores presses.
 * The rendered web DOM (a native <button disabled aria-disabled>, skipped by
 * Tab, inert to Enter; enabled → focusable and Enter activates) is checked
 * end to end in e2e/member.mjs.
 */
import { render, screen, userEvent } from '@testing-library/react-native';

import { Button } from '../Button';

describe('Button', () => {
  it('enabled: a button with its label, pressable', async () => {
    const onPress = jest.fn();
    await render(<Button label="Continue" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeEnabled();
    await userEvent.setup().press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled: exposed as disabled to assistive technology, and presses do nothing', async () => {
    const onPress = jest.fn();
    await render(<Button label="Continue" onPress={onPress} disabled testID="b" />);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
    await userEvent.setup().press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('loading: busy and disabled; the label stays the accessible name', async () => {
    const onPress = jest.fn();
    await render(<Button label="Submit application" onPress={onPress} loading />);
    const button = screen.getByRole('button', { name: 'Submit application' });
    expect(button).toBeDisabled();
    expect(button).toBeBusy();
    await userEvent.setup().press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('keeps a custom accessibility label and hint', async () => {
    await render(<Button label="Change" accessibilityLabel="Change: Replace a photo" accessibilityHint="Opens the request" onPress={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Change: Replace a photo' }).props.accessibilityHint).toBe('Opens the request');
  });
});
