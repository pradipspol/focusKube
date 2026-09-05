import { uiText } from '../text';

/**
 * Shared "Validate" affordance for every YAML editor (create-resource, edit-resource YAML, ...).
 * Validation always runs as an explicit, separate action from Save/Deploy - it never blocks
 * them - so every caller wires its own useMutation and just renders these two pieces from it.
 */

interface ValidateYamlButtonProps {
  onValidate: () => void;
  isPending: boolean;
  disabled?: boolean;
}

export function ValidateYamlButton({ onValidate, isPending, disabled }: ValidateYamlButtonProps) {
  return (
    <button onClick={onValidate} disabled={disabled || isPending}>
      {isPending ? uiText.common.validating : uiText.common.validate}
    </button>
  );
}

interface YamlValidationNoticeProps {
  isError: boolean;
  errorMessage?: string;
  successMessage?: string;
  idleMessage?: string;
}

export function YamlValidationNotice({ isError, errorMessage, successMessage, idleMessage }: YamlValidationNoticeProps) {
  if (isError) return <span className="notice error">{errorMessage ?? uiText.common.yamlValidationFailed}</span>;
  if (successMessage) return <span className="notice success">{successMessage}</span>;
  if (idleMessage) return <span className="dim">{idleMessage}</span>;
  return null;
}
