// 仅导入类型：DatabaseMigration 命名空间，用于约束下方迁移数组的元素类型
import type { DatabaseMigration } from "./migration.js"
// m00：导入迁移 20260127222353_familiar_lady_ursula（默认导出，下同）
import m00 from "./migration/20260127222353_familiar_lady_ursula.js"
// m01：导入迁移 add_project_commands（新增项目命令）
import m01 from "./migration/20260211171708_add_project_commands.js"
// m02：导入迁移 wakeful_the_professor（自动命名的迁移）
import m02 from "./migration/20260213144116_wakeful_the_professor.js"
// m03：导入迁移 workspace（工作区）
import m03 from "./migration/20260225215848_workspace.js"
// m04：导入迁移 add_session_workspace_id（为会话添加 workspace_id）
import m04 from "./migration/20260227213759_add_session_workspace_id.js"
// m05：导入迁移 blue_harpoon（自动命名的迁移）
import m05 from "./migration/20260228203230_blue_harpoon.js"
// m06：导入迁移 add_workspace_fields（新增工作区字段）
import m06 from "./migration/20260303231226_add_workspace_fields.js"
// m07：导入迁移 move_org_to_state（把组织信息迁移到状态）
import m07 from "./migration/20260309230000_move_org_to_state.js"
// m08：导入迁移 session_message_cursor（会话消息游标）
import m08 from "./migration/20260312043431_session_message_cursor.js"
// m09：导入迁移 events（事件表）
import m09 from "./migration/20260323234822_events.js"
// m10：导入迁移 workspace-name（工作区名称）
import m10 from "./migration/20260410174513_workspace-name.js"
// m11：导入迁移 chief_energizer（自动命名的迁移）
import m11 from "./migration/20260413175956_chief_energizer.js"
// m12：导入迁移 add_icon_url_override（新增图标 URL 覆盖项）
import m12 from "./migration/20260423070820_add_icon_url_override.js"
// m13：导入迁移 slow_nightmare（自动命名的迁移）
import m13 from "./migration/20260427172553_slow_nightmare.js"
// m14：导入迁移 add_session_path（为会话添加路径）
import m14 from "./migration/20260428004200_add_session_path.js"
// m15：导入迁移 next_venus（自动命名的迁移）
import m15 from "./migration/20260501142318_next_venus.js"
// m16：导入迁移 add_sync_owner（新增同步属主）
import m16 from "./migration/20260504145000_add_sync_owner.js"
// m17：导入迁移 add_workspace_time（新增工作区时间字段）
import m17 from "./migration/20260507164347_add_workspace_time.js"
// m18：导入迁移 session_usage（会话用量）
import m18 from "./migration/20260510033149_session_usage.js"
// m19：导入迁移 data_migration_state（数据迁移状态）
import m19 from "./migration/20260511000411_data_migration_state.js"
// m20：导入迁移 session-metadata（会话元数据）
import m20 from "./migration/20260511173437_session-metadata.js"
// m21：导入迁移 normalize_storage_paths（规范化存储路径）
import m21 from "./migration/20260601010001_normalize_storage_paths.js"
// m22：导入迁移 amazing_prowler（自动命名的迁移）
import m22 from "./migration/20260601202201_amazing_prowler.js"
// m23：导入迁移 lowly_union_jack（自动命名的迁移）
import m23 from "./migration/20260602002951_lowly_union_jack.js"
// m24：导入迁移 add_project_directories（新增项目目录）
import m24 from "./migration/20260602182828_add_project_directories.js"
// m25：导入迁移 session_message_projection_indexes（会话消息投影索引）
import m25 from "./migration/20260603001617_session_message_projection_indexes.js"
// m26：导入迁移 session_message_projection_order（会话消息投影顺序）
import m26 from "./migration/20260603040000_session_message_projection_order.js"
// m27：导入迁移 session_input_inbox（会话输入收件箱）
import m27 from "./migration/20260603141458_session_input_inbox.js"
// m28：导入迁移 jittery_ezekiel_stane（自动命名的迁移）
import m28 from "./migration/20260603160727_jittery_ezekiel_stane.js"
// m29：导入迁移 event_sourced_session_input（事件溯源的会话输入）
import m29 from "./migration/20260604172448_event_sourced_session_input.js"
// m30：导入迁移 add_session_context_snapshot（新增会话上下文快照）
import m30 from "./migration/20260605003541_add_session_context_snapshot.js"
// m31：导入迁移 add_context_epoch_agent（新增上下文纪元与代理）
import m31 from "./migration/20260605042240_add_context_epoch_agent.js"
// m32：导入迁移 credential（凭据表）
import m32 from "./migration/20260611035744_credential.js"
// m33：导入迁移 lush_chimera（自动命名的迁移）
import m33 from "./migration/20260611192811_lush_chimera.js"
// m34：导入迁移 project_dir_strategy（项目目录策略）
import m34 from "./migration/20260612174303_project_dir_strategy.js"
// m35：导入迁移 simplify_session_context_epoch（简化会话上下文纪元）
import m35 from "./migration/20260622142730_simplify_session_context_epoch.js"
// m36：导入迁移 reset_v2_session_state（重置 v2 会话状态）
import m36 from "./migration/20260622170816_reset_v2_session_state.js"
// m37：导入迁移 simplify_session_input（简化会话输入）
import m37 from "./migration/20260622202450_simplify_session_input.js"
// m38：导入迁移 loose_psylocke（自动命名的迁移）
import m38 from "./migration/20260804233008_loose_psylocke.js"
// m39：导入迁移 import_legacy_credentials（导入旧版凭据）
import m39 from "./migration/20260805200742_import_legacy_credentials.js"
// m40：导入迁移 workspace_domain（工作区域）
import m40 from "./migration/20260808023530_workspace_domain.js"
// m41：导入迁移 execution_claim_attempts（执行认领尝试）
import m41 from "./migration/20260811161259_execution_claim_attempts.js"
// m42：导入迁移 session_inbox（会话收件箱）
import m42 from "./migration/20260812181746_session_inbox.js"
// m43：导入迁移 worktree（工作树）
import m43 from "./migration/20260812213948_worktree.js"
// m44：导入迁移 session_viewed_state（会话已读状态）
import m44 from "./migration/20260819222447_session_viewed_state.js"
// m45：导入迁移 nullable_workspace_binding（可空的工作区绑定）
import m45 from "./migration/20260823191254_nullable_workspace_binding.js"
// m46：导入迁移 clear_v1_session_permission（清理 v1 会话权限）
import m46 from "./migration/20260910120000_clear_v1_session_permission.js"
// m47：导入迁移 project_time_active（项目活跃时间）
import m47 from "./migration/20260923013825_project_time_active.js"
// m48：导入迁移 azure_cli_external_credential（Azure CLI 外部凭据）
import m48 from "./migration/20261007190000_azure_cli_external_credential.js"
// m49：导入迁移 project_time_archived（项目归档时间）
import m49 from "./migration/20261010180456_project_time_archived.js"
// m50：导入迁移 session_allowance（会话额度）
import m50 from "./migration/20261024002554_session_allowance.js"
// m51：导入迁移 drop_session_allowance（删除会话额度）
import m51 from "./migration/20261024175301_drop_session_allowance.js"
// m52：导入迁移 blob（二进制大对象）
import m52 from "./migration/20261025123711_blob.js"
// m53：导入迁移 drop_session_pending（删除会话待处理状态）
import m53 from "./migration/20261025154125_drop_session_pending.js"
// m54：导入迁移 schedule（计划任务）
import m54 from "./migration/20261026223005_schedule.js"
// m55：导入迁移 session_part（会话部分）
import m55 from "./migration/20261029002625_session_part.js"
// m56：导入迁移 session_time_busy（会话忙时）
import m56 from "./migration/20261029073502_session_time_busy.js"
// m57：导入迁移 schedule_checks（计划任务检查）
import m57 from "./migration/20261029165540_schedule_checks.js"
// m58：导入迁移 job（作业）
import m58 from "./migration/20261030054400_job.js"

// 迁移注册表：按时间戳顺序排列全部迁移，元素类型必须满足 DatabaseMigration.Migration 约束。
// 执行顺序即数组顺序，新增迁移时需在末尾追加（先加 import，再加入本数组）。
export const migrations = [
  m00,
  m01,
  m02,
  m03,
  m04,
  m05,
  m06,
  m07,
  m08,
  m09,
  m10,
  m11,
  m12,
  m13,
  m14,
  m15,
  m16,
  m17,
  m18,
  m19,
  m20,
  m21,
  m22,
  m23,
  m24,
  m25,
  m26,
  m27,
  m28,
  m29,
  m30,
  m31,
  m32,
  m33,
  m34,
  m35,
  m36,
  m37,
  m38,
  m39,
  m40,
  m41,
  m42,
  m43,
  m44,
  m45,
  m46,
  m47,
  m48,
  m49,
  m50,
  m51,
  m52,
  m53,
  m54,
  m55,
  m56,
  m57,
  m58,
] satisfies DatabaseMigration.Migration[]
