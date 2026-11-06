// 从 drizzle-orm/sqlite-core 导入 integer：SQLite 整数列构造器
import { integer } from "drizzle-orm/sqlite-core"

// Timestamps：公共时间戳（timestamps）列集合，供各表 drizzle 定义复用
export const Timestamps = {
  // time_created：创建时间（毫秒时间戳），非空，插入时自动取当前时间
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  // time_updated：更新时间（毫秒时间戳），非空，每次更新行时自动刷新
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
}
