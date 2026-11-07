"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

const periodSchema = z.string().regex(/^\d{4}-\d{2}$/);

async function requireUser() {
  const session = await getSession();
  if (!session) throw new Error("You must be signed in.");
  return session.user;
}

export async function decideException(input: {
  exceptionId: string;
  decision: "CLAIM" | "DEFER" | "REVERSE";
  period: string;
}) {
  const user = await requireUser();
  const period = periodSchema.parse(input.period);
  const exception = await db.gstException.findUnique({ where: { id: input.exceptionId } });
  if (!exception || exception.period !== period) throw new Error("GST exception not found.");

  const status = { CLAIM: "CLAIMED", DEFER: "DEFERRED", REVERSE: "REVERSED" } as const;
  await db.$transaction([
    db.itcDecision.create({
      data: {
        exceptionId: exception.id,
        decision: input.decision,
        actor: user.email,
        scope: `${period} GST Close Room`,
      },
    }),
    db.gstException.update({ where: { id: exception.id }, data: { status: status[input.decision] } }),
  ]);
  revalidatePath(`/gst?period=${period}`);
}

export async function approvePeriod(periodInput: string) {
  const user = await requireUser();
  const period = periodSchema.parse(periodInput);
  await db.gstPeriod.upsert({
    where: { period },
    create: { period, status: "SIGNED_OFF", signedOffBy: user.email, signedOffAt: new Date() },
    update: { status: "SIGNED_OFF", signedOffBy: user.email, signedOffAt: new Date() },
  });
  revalidatePath(`/gst?period=${period}`);
}
