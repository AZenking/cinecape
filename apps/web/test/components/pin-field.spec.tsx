import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PinField } from '../../src/shared/ui';

function Harness(): ReactNode {
  const [value, setValue] = useState('');
  return (
    <>
      <PinField name="pin" label="档案 PIN" value={value} onValueChange={setValue} />
      <output data-testid="pin-value">{value}</output>
    </>
  );
}

describe('PinField', () => {
  it('accepts only six digits and keeps the controlled value synchronized', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    const input = screen.getByLabelText('档案 PIN');
    await user.type(input, '12a345678');

    expect(input).toHaveValue('123456');
    expect(screen.getByTestId('pin-value')).toHaveTextContent('123456');
    expect(container.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-slot="input-otp-slot"][data-filled="true"]')).toHaveLength(6);
  });
});
