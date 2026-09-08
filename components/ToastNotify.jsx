"use client";

import { toast } from "sonner";

const options = {
  duration: 4000,
};

export const notify = {
  success: (message) => toast.success(message, options),
  error: (message) => toast.error(message, options),
  info: (message) => toast.info(message, options),
  warning: (message) => toast.warning(message, options),
  default: (message) => toast(message, options),
};
