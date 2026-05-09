import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  select,
  selectKey,
  text
} from "@clack/prompts";
import {
  isTtyAvailable,
  NoTtyError,
  openTtyStreams,
  type TtyStreams
} from "../ui/tty.js";

export { isTtyAvailable, NoTtyError };

export type PromptResult<T> = { value: T };

function handleCancel<T>(value: T | symbol, stream: TtyStreams): asserts value is T {
  if (!isCancel(value)) return;
  cancel("Setup canceled.", { output: stream.output, withGuide: false });
  stream.close();
  process.exit(0);
}

async function withPromptStreams<T>(run: (stream: TtyStreams) => Promise<T>): Promise<T> {
  if (!isTtyAvailable()) throw new NoTtyError();
  const stream = openTtyStreams();
  try {
    return await run(stream);
  } finally {
    stream.close();
  }
}

export async function ask(question: string): Promise<string> {
  return withPromptStreams(async (stream) => {
    const answer = await text({
      message: question,
      input: stream.input,
      output: stream.output,
      withGuide: false
    });
    handleCancel(answer, stream);
    return String(answer).trim();
  });
}

export type Choice<T> = {
  key: string;
  label: string;
  value: T;
  applyToAllKey?: string;
  hint?: string;
  disabled?: boolean;
};

export async function askChoice<T>(
  prompt: string,
  choices: Choice<T>[],
  _options?: { applyToAllPrompt?: string }
): Promise<{ value: T; applyToAll: boolean }> {
  if (choices.length === 0) throw new Error("askChoice requires at least one choice");
  return withPromptStreams(async (stream) => {
    const byKey = new Map<string, { value: T; applyToAll: boolean }>();
    const options: Array<{ value: string; label: string; hint?: string; disabled?: boolean }> = [];

    for (const choice of choices) {
      byKey.set(choice.key, { value: choice.value, applyToAll: false });
      options.push({
        value: choice.key,
        label: choice.label,
        hint: choice.hint,
        disabled: choice.disabled
      });
      if (choice.applyToAllKey) {
        byKey.set(choice.applyToAllKey, { value: choice.value, applyToAll: true });
        options.push({
          value: choice.applyToAllKey,
          label: choice.label,
          hint: "apply to all remaining",
          disabled: choice.disabled
        });
      }
    }

    const initialValue = choices.find((choice) => !choice.disabled)?.key ?? choices[0].key;
    const selected = await selectKey<string>({
      message: prompt,
      options,
      initialValue,
      caseSensitive: true,
      input: stream.input,
      output: stream.output,
      withGuide: true
    });
    handleCancel(selected, stream);
    const result = byKey.get(selected);
    if (!result) throw new Error(`unrecognized choice: ${selected}`);
    return result;
  });
}

export async function askSelect<T>(
  prompt: string,
  choices: Array<{ label: string; value: T; hint?: string; disabled?: boolean }>,
  options: { initialValue?: T; maxItems?: number } = {}
): Promise<T> {
  if (choices.length === 0) throw new Error("askSelect requires at least one choice");
  return withPromptStreams(async (stream) => {
    const selectOptions = choices as never;
    const selected = await select<T>({
      message: prompt,
      options: selectOptions,
      initialValue: options.initialValue,
      maxItems: options.maxItems,
      input: stream.input,
      output: stream.output,
      withGuide: true
    });
    handleCancel(selected, stream);
    return selected;
  });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  return withPromptStreams(async (stream) => {
    const answer = await clackConfirm({
      message: question,
      initialValue: defaultYes,
      active: "Yes",
      inactive: "No",
      input: stream.input,
      output: stream.output,
      withGuide: false
    });
    handleCancel(answer, stream);
    return answer;
  });
}
