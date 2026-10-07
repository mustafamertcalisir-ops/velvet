import { StepGuard } from '@/navigation/StepGuard';
import { NameStep } from '@/screens/NameStep';

export default function LastNameRoute() {
  return (
    <StepGuard step="last-name">
      <NameStep field="lastName" />
    </StepGuard>
  );
}
