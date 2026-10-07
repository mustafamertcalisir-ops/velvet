import { StepGuard } from '@/navigation/StepGuard';
import { NameStep } from '@/screens/NameStep';

export default function FirstNameRoute() {
  return (
    <StepGuard step="first-name">
      <NameStep field="firstName" />
    </StepGuard>
  );
}
