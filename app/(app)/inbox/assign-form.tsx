"use client";

import { ActionForm } from "@/components/forms";
import { NativeSelect } from "@/components/ui/native-select";
import type { ActionState } from "@/lib/actions";
import type { Member } from "@/lib/team/mentions";

/** "Assigned to" picker for a conversation: saves as soon as a person is picked. */
export function AssignForm({ action, members, current }: { action: (prev: ActionState, form: FormData) => Promise<ActionState>; members: Member[]; current: string }) {
  return (
    <ActionForm action={action} className="flex items-center gap-2">
      <NativeSelect
        key={current}
        name="assignee"
        defaultValue={current}
        aria-label="Assign this conversation"
        className="h-8 w-auto min-w-44 text-sm"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        <option value="">Nobody (unassigned)</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </NativeSelect>
    </ActionForm>
  );
}
