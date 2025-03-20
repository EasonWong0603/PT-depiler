import { toRaw, isRef, isReactive, isProxy } from "vue";
import { filesize, type FileSizeOptions } from "filesize";
import { format as dateFormat } from "date-fns";

export function deepToRaw<T extends Record<string, any>>(sourceObj: T): T {
  const objectIterator = (input: any): any => {
    if (Array.isArray(input)) {
      return input.map((item) => objectIterator(item));
    }
    if (isRef(input) || isReactive(input) || isProxy(input)) {
      return objectIterator(toRaw(input));
    }
    if (input && typeof input === "object") {
      return Object.keys(input).reduce((acc, key) => {
        acc[key as keyof typeof acc] = objectIterator(input[key]);
        return acc;
      }, {} as T);
    }
    return input;
  };

  return objectIterator(sourceObj);
}

export const formValidateRules: Record<string, (args?: any) => (v: any) => boolean | string> = {
  require: (args: string = "Item is required") => {
    return (v: any) => !!v || args;
  },
  url: (args: string = "Not url") => {
    return (v: any) => /^(https?):\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;[\]]+[-A-Za-z0-9+&@#/%=~_|]$/.test(v) || args;
  },
};

export const formatSize = (size: number, options?: FileSizeOptions) => filesize(size, { base: 2, ...(options ?? {}) });
export const formatDate = (date: number, format: string = "yyyy-MM-dd HH:mm:ss") => dateFormat(date, format);
export const formatNumber = (
  num: number,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 2, minimumFractionDigits: 2 },
) => Number(num).toLocaleString("en-US", options);
