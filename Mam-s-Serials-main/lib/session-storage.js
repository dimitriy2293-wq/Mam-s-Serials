import { supabase } from "./supabase.js";

// Storage adapter для grammy session() — сохраняет прогресс диалога (шаг, черновик
// сценария, персонажей) в Supabase вместо памяти процесса. Это критично на бесплатном
// Render: процесс "усыпляется"/перезапускается без входящего трафика, и всё, что было
// только в памяти, стирается — пользователь на середине диалога получает "зависший" бот.
export const supabaseSessionStorage = {
  async read(key) {
    const { data, error } = await supabase
      .from("bot_sessions")
      .select("data")
      .eq("telegram_id", key)
      .maybeSingle();
    if (error) {
      console.error("Ошибка чтения сессии:", error);
      return undefined;
    }
    return data?.data;
  },

  async write(key, value) {
    const { error } = await supabase
      .from("bot_sessions")
      .upsert({ telegram_id: key, data: value, updated_at: new Date().toISOString() });
    if (error) console.error("Ошибка записи сессии:", error);
  },

  async delete(key) {
    const { error } = await supabase.from("bot_sessions").delete().eq("telegram_id", key);
    if (error) console.error("Ошибка удаления сессии:", error);
  },
};
