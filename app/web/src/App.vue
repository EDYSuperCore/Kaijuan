<template>
  <div class="container">
    <!-- App Logo and Title -->
    <div class="app-logo">
      <img src="/icon.png" alt="开卷 Logo" />
      <div>
        <h1>开卷</h1>
        <p class="app-subtitle">Kaijuan — Youyi</p>
      </div>
    </div>

    <!-- Navigation -->
    <div class="nav">
      <a href="#" :class="{ active: currentPage === 'home' }" @click.prevent="goHome">首页</a>
      <a href="#settings" :class="{ active: currentPage === 'settings' }" @click.prevent="goSettings">设置</a>
    </div>

    <!-- Home Page -->
    <div id="pageHome" class="page" :class="{ active: currentPage === 'home' }">
      <div class="section section-scan">
        <h2 class="scan-title">扫描并创建任务</h2>
        <div class="form-group">
          <label for="rootPath">目录路径:</label>
          <div class="scan-path">
            <input
              id="rootPath"
              v-model="rootPath"
              type="text"
              placeholder="例如: /volume1/archives"
            />
            <button id="selectDirBtn" class="btn" @click="showDirSelector">
              <i class="bi bi-folder2-open" aria-hidden="true"></i>
              选择目录
            </button>
          </div>
        </div>
        <div class="scan-actions">
          <button id="scanBtn" class="btn btn-secondary" :disabled="scanInProgress" @click="scanDirectory">
            <i class="bi bi-search" aria-hidden="true"></i>
            <span class="btn-label">{{ scanInProgress ? '扫描中...' : '扫描' }}</span>
          </button>
          <button id="createJobBtn" class="btn btn-outline" :disabled="selectedFiles.length === 0" @click="openConfigModal">
            <i class="bi bi-plus-circle" aria-hidden="true"></i>
            <span class="btn-label">创建任务</span>
          </button>
        </div>
        <div id="scanStatus" class="status" v-show="status.scan.visible" :class="statusClass(status.scan)">
          {{ status.scan.message }}
        </div>
        <div id="createJobStatus" class="status" v-show="status.createJob.visible" :class="statusClass(status.createJob)">
          {{ status.createJob.message }}
        </div>

        <div id="fileList" class="file-list scan-file-list" v-show="selectedFiles.length > 0">
          <div id="fileListContent">
            <div v-for="item in limitedFiles" :key="item.path" class="file-item">
              <div class="file-path">{{ item.path }}</div>
              <div class="file-size">{{ formatSize(item.size) }}</div>
            </div>
            <div v-if="selectedFiles.length > 100" style="padding: 10px; text-align: center; color: #999;">
              ... 还有 {{ selectedFiles.length - 100 }} 个文件
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <h2 style="margin: 0;">任务列表</h2>
          <button id="clearFailedBtn" class="btn btn-danger" @click="handleClearFailed">
            <i class="bi bi-trash3" aria-hidden="true"></i>
            清除失败任务
          </button>
        </div>
        <div id="jobsList" class="jobs-list">
          <div v-if="jobs.length === 0" style="text-align: center; color: #999; padding: 20px;">
            暂无任务，请先扫描并创建任务
          </div>
          <div v-for="job in jobs" :key="job.id" class="job-item" :data-job-id="job.id">
            <div class="job-header">
              <span class="job-id">任务 #{{ job.id }}{{ retryFromText(job) }}</span>
              <span class="job-status" :class="job.status || 'pending'">{{ getStatusText(job.status) }}</span>
              <div style="display: flex; gap: 5px;">
                <button
                  v-if="job.status === 'failed'"
                  class="btn-retry-job btn-warning btn-small"
                  :data-job-id="job.id"
                  title="重试任务"
                  @click="handleRetryJob(job.id)"
                >
                  <i class="bi bi-arrow-repeat" aria-hidden="true"></i>
                  <span class="btn-label">重试</span>
                </button>
                <button
                  class="btn-delete-job"
                  :disabled="!isJobDeletable(job.status)"
                  :title="isJobDeletable(job.status) ? '删除任务' : '进行中的任务无法删除'"
                  :data-job-id="job.id"
                  @click="isJobDeletable(job.status) && handleDeleteJob(job.id)"
                >
                  <i class="bi bi-trash3" aria-hidden="true"></i>
                  <span class="btn-label">删除</span>
                </button>
              </div>
            </div>
            <div class="job-info">
              <div>路径: {{ job.root_path || '' }}</div>
              <div>
                成功: {{ job.success || 0 }} / 失败: {{ job.failed || 0 }} / 跳过: {{ job.skipped || 0 }} / 总计: {{ job.total || 0 }}
              </div>
              <div>创建时间: {{ formatTime(job.created_at) }}</div>
              <div v-if="job.started_at">开始时间: {{ formatTime(job.started_at) }}</div>
              <div v-if="job.ended_at">结束时间: {{ formatTime(job.ended_at) }}</div>
              <div v-if="job.last_error" style="color: #e74c3c; margin-top: 5px;">错误: {{ job.last_error }}</div>
            </div>
            <div v-if="job.total > 0" class="job-progress-container">
              <div class="job-progress-bar">
                <div
                  class="job-progress-fill"
                  :class="{ running: job.status === 'running' }"
                  :style="{ width: jobProgress(job) + '%' }"
                ></div>
              </div>
            </div>
            <div class="job-actions">
              <button class="btn-view-logs" :data-job-id="job.id" @click="toggleJobLogs(job)">
                <i class="bi bi-list" aria-hidden="true"></i>
                <span class="btn-label">{{ expandedLogs.has(job.id) ? '隐藏日志' : '查看日志' }}</span>
              </button>
            </div>
            <div class="job-logs" :class="{ show: expandedLogs.has(job.id) }" :id="`job-logs-${job.id}`">
              {{ jobLogContent(job.id) }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Settings Page -->
    <div id="pageSettings" class="page" :class="{ active: currentPage === 'settings' }">
      <div class="section">
        <h2>应用设置</h2>

        <div class="form-group">
          <label>冲突策略</label>
          <div class="radio-group">
            <div class="radio-option">
              <input id="conflictSkip" v-model="settingsDraft.conflict" type="radio" name="conflict" value="skip" @change="scheduleAutoSave" />
              <label for="conflictSkip">跳过 - 如果目标已存在则跳过该文件</label>
            </div>
            <div class="radio-option">
              <input id="conflictOverwrite" v-model="settingsDraft.conflict" type="radio" name="conflict" value="overwrite" @change="scheduleAutoSave" />
              <label for="conflictOverwrite">覆盖 - 如果目标已存在则覆盖</label>
            </div>
            <div class="radio-option">
              <input id="conflictRename" v-model="settingsDraft.conflict" type="radio" name="conflict" value="rename" @change="scheduleAutoSave" />
              <label for="conflictRename">重命名 - 如果目标已存在则自动重命名</label>
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>输出方式</label>
          <div class="radio-group">
            <div class="radio-option">
              <input id="outputSibling" v-model="settingsDraft.outputMode" type="radio" name="outputMode" value="sibling_named_dir" @change="scheduleAutoSave" />
              <label for="outputSibling">同级命名目录 - 在压缩包同级创建同名目录</label>
            </div>
            <div class="radio-option">
              <input id="outputInPlace" v-model="settingsDraft.outputMode" type="radio" name="outputMode" value="in_place" disabled />
              <label for="outputInPlace" style="color: #999;">原地解压 - 直接解压到压缩包所在目录（暂未实现）</label>
            </div>
            <div class="radio-option">
              <input id="outputCustom" v-model="settingsDraft.outputMode" type="radio" name="outputMode" value="custom" disabled />
              <label for="outputCustom" style="color: #999;">自定义目录 - 解压到指定目录（暂未实现）</label>
            </div>
          </div>
          <div class="disabled-hint">当前仅支持"同级命名目录"模式</div>
        </div>

        <div class="form-group">
          <label>Zip Slip 防护</label>
          <div class="switch-group">
            <label class="switch">
              <input id="zipSlipPolicy" v-model="zipSlipChecked" type="checkbox" @change="handleZipSlipChange" />
              <span class="slider"></span>
            </label>
            <label for="zipSlipPolicy" style="margin: 0; cursor: pointer;">允许路径穿越（危险）</label>
          </div>
          <div id="zipSlipWarning" class="warning-box" v-show="settingsDraft.zipSlipPolicy === 'allow'">
            <strong>⚠️ 安全警告：</strong>开启此选项将允许压缩包中的文件解压到目标目录之外，可能导致系统文件被覆盖或泄露。强烈建议保持关闭状态。
          </div>
        </div>

        <div class="form-group">
          <label>常用密码</label>
          <div style="margin-bottom: 10px; font-size: 13px; color: #666;">管理常用解压密码列表，用于批量解压加密压缩包</div>
          <div id="commonPasswordsList" style="margin-bottom: 10px;">
            <div v-if="settingsDraft.commonPasswords.length === 0" style="color: #999; font-size: 13px; padding: 10px;">
              暂无常用密码
            </div>
            <div
              v-for="(pwd, index) in settingsDraft.commonPasswords"
              :key="`${index}-${pwd}`"
              style="display: flex; align-items: center; gap: 10px; padding: 8px; background: #f8f9fa; border-radius: 4px; margin-bottom: 8px;"
            >
              <span style="font-weight: 500; color: #666; min-width: 30px;">#{{ index + 1 }}</span>
              <span
                style="flex: 1; font-family: monospace; font-size: 13px; cursor: pointer;"
                :title="passwordReveal[index] ? '点击隐藏密码' : '点击显示完整密码（仅本地查看）'"
                @click="togglePasswordReveal(index)"
              >
                {{ passwordReveal[index] ? pwd : getPasswordPreview(pwd) }}
              </span>
              <button
                type="button"
                style="padding: 4px 8px; background: #6c757d; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;"
                title="显示/隐藏完整密码"
                @click="togglePasswordReveal(index)"
              >
                👁
              </button>
              <button
                type="button"
                style="padding: 4px 8px; background: #95a5a6; color: white; border: none; border-radius: 3px; cursor: pointer;"
                :disabled="index === 0"
                @click="movePassword(index, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                style="padding: 4px 8px; background: #95a5a6; color: white; border: none; border-radius: 3px; cursor: pointer;"
                :disabled="index === settingsDraft.commonPasswords.length - 1"
                @click="movePassword(index, 1)"
              >
                ↓
              </button>
              <button
                type="button"
                style="padding: 4px 8px; background: #e74c3c; color: white; border: none; border-radius: 3px; cursor: pointer;"
                @click="removePassword(index)"
              >
                删除
              </button>
            </div>
          </div>
          <div style="display: flex; gap: 10px; margin-bottom: 10px;">
            <input id="newPasswordInput" v-model="newPassword" type="password" class="input-flex" placeholder="输入新密码" @keypress.enter="addPassword" />
            <button id="addPasswordBtn" class="btn" @click="addPassword">
              <i class="bi bi-plus-lg" aria-hidden="true"></i>
              添加
            </button>
          </div>
        </div>

        <div style="margin-top: 20px;">
          <button id="resetSettingsBtn" class="btn btn-secondary" @click="resetSettings">
            <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>
            重置为默认
          </button>
          <span
            id="settingsSaveStatus"
            style="margin-left: 10px; font-size: 13px; color: #666;"
            :style="{ color: settingsSaveStatusColor, cursor: settingsSaveStatusClickable ? 'pointer' : 'default' }"
            @click="settingsSaveStatusClickable && retryAutoSave()"
          >
            {{ settingsSaveStatus }}
          </span>
        </div>
        <div id="settingsStatus" class="status" v-show="status.settings.visible" :class="statusClass(status.settings)">
          {{ status.settings.message }}
        </div>
      </div>
    </div>

    <!-- Job Detail Page -->
    <div id="pageJobDetail" class="page" :class="{ active: currentPage === 'detail' }">
      <div style="margin-bottom: 20px;">
        <button id="backToJobsBtn" class="btn btn-secondary" @click="goHome">
          <i class="bi bi-arrow-left" aria-hidden="true"></i>
          返回任务列表
        </button>
      </div>

      <div id="jobDetailError" class="error-banner" :class="{ show: jobDetailError !== '' }">{{ jobDetailError }}</div>

      <div id="jobDetailContent" v-show="jobDetailData !== null">
        <div class="job-detail-summary" v-if="jobDetailData">
          <h2>任务详情 #<span id="jobDetailId">{{ jobDetailData.job.id }}</span></h2>

          <div class="summary-row">
            <div class="summary-item">
              <div class="summary-label">路径</div>
              <div class="summary-value" id="jobDetailRootPath">{{ jobDetailData.job.root_path || '-' }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">状态</div>
              <div class="summary-value" id="jobDetailStatus">
                <span class="status-tag" :class="jobDetailData.job.status || 'pending'">{{ getStatusText(jobDetailData.job.status) }}</span>
              </div>
            </div>
          </div>

          <div class="summary-row">
            <div class="summary-item">
              <div class="summary-label">进度</div>
              <div class="progress-bar-container">
                <div class="progress-bar" id="jobDetailProgressBar" :style="{ width: jobDetailProgress.percent + '%' }">
                  {{ jobDetailProgress.label }}
                </div>
              </div>
            </div>
          </div>

          <div class="summary-row">
            <div class="summary-item">
              <div class="summary-label">成功</div>
              <div class="summary-value" id="jobDetailSuccess">{{ jobDetailData.job.success || 0 }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">失败</div>
              <div class="summary-value" id="jobDetailFailed">{{ jobDetailData.job.failed || 0 }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">跳过</div>
              <div class="summary-value" id="jobDetailSkipped">{{ jobDetailData.job.skipped || 0 }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">已取消</div>
              <div class="summary-value" id="jobDetailCanceled">{{ jobDetailData.job.canceled || 0 }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">总计</div>
              <div class="summary-value" id="jobDetailTotal">{{ jobDetailData.job.total || 0 }}</div>
            </div>
          </div>

          <div class="summary-row">
            <div class="summary-item">
              <div class="summary-label">创建时间</div>
              <div class="summary-value" id="jobDetailCreatedAt">{{ formatTime(jobDetailData.job.created_at) || '-' }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">开始时间</div>
              <div class="summary-value" id="jobDetailStartedAt">{{ formatTime(jobDetailData.job.started_at || 0) || '-' }}</div>
            </div>
            <div class="summary-item">
              <div class="summary-label">结束时间</div>
              <div class="summary-value" id="jobDetailEndedAt">{{ jobDetailEndedText }}</div>
            </div>
          </div>
        </div>

        <div class="controls-bar">
          <label>
            <input id="autoRefreshToggle" type="checkbox" v-model="jobDetailAutoRefresh" @change="toggleJobDetailPolling" />
            自动刷新
          </label>
          <select id="refreshInterval" v-model.number="jobDetailRefreshInterval" @change="toggleJobDetailPolling">
            <option :value="1000">1秒</option>
            <option :value="2000">2秒</option>
            <option :value="5000">5秒</option>
          </select>
          <label>
            <input id="filterFailed" type="checkbox" v-model="jobDetailFilterFailed" />
            仅显示失败
          </label>
          <button id="manualRefreshBtn" @click="manualRefreshJobDetail">手动刷新</button>
        </div>

        <div class="section">
          <h2>任务项列表</h2>
          <div style="overflow-x: auto;">
            <table class="items-table">
              <thead>
                <tr>
                  <th style="width: 30%;">路径</th>
                  <th style="width: 10%;">状态</th>
                  <th style="width: 30%;">消息</th>
                  <th style="width: 20%;">输出目录</th>
                  <th style="width: 10%;">耗时</th>
                </tr>
              </thead>
              <tbody id="jobDetailItemsTable">
                <tr v-if="jobDetailItems.length === 0">
                  <td colspan="5" style="text-align: center; padding: 20px; color: #999;">
                    {{ jobDetailFilterFailed ? '没有失败的任务项' : '暂无任务项' }}
                  </td>
                </tr>
                <tr v-for="item in jobDetailItems" :key="item.id">
                  <td class="path-cell" style="position: relative;">
                    <span>{{ truncatePath(item.archive_path) }}</span>
                    <span class="path-full">{{ item.archive_path }}</span>
                    <button class="copy-btn" @click="copyToClipboard(item.archive_path)">复制</button>
                  </td>
                  <td>
                    <span class="status-tag" :class="item.status || 'pending'">{{ getStatusText(item.status) }}</span>
                  </td>
                  <td>
                    {{ item.failed_detail ? item.failed_detail : '-' }}
                    <button v-if="item.failed_detail" class="copy-btn" @click="copyToClipboard(item.failed_detail)">复制</button>
                  </td>
                  <td>
                    {{ item.out_dir ? item.out_dir : '-' }}
                    <button v-if="item.out_dir" class="copy-btn" @click="copyToClipboard(item.out_dir)">复制</button>
                  </td>
                  <td>{{ formatDuration(item.started_at, item.ended_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast" :class="{ show: toastVisible }">已复制到剪贴板</div>

  <div id="versionInfo" class="version-info">Version: <span id="versionText">{{ versionText }}</span></div>

  <div class="dark-mode-toggle" id="darkModeToggle" @click="toggleDarkMode">
    <span class="dark-mode-toggle-icon" id="darkModeIcon">{{ darkModeIcon }}</span>
    <span id="darkModeText">{{ darkModeText }}</span>
  </div>

  <!-- Config Modal -->
  <div id="configModal" class="config-modal" :class="{ show: configModalOpen }" @click.self="closeConfigModal">
    <div class="config-modal-content">
      <div class="config-modal-header">
        <h2>创建解压任务</h2>
        <button class="config-modal-close" id="closeConfigModal" @click="closeConfigModal">&times;</button>
      </div>

      <div class="form-group">
        <label>解压密码</label>
        <div class="radio-group">
          <div class="radio-option">
            <input id="modalPasswordNone" v-model="modalPasswordMode" type="radio" name="modalPasswordMode" value="none" />
            <label for="modalPasswordNone">不使用密码</label>
          </div>
          <div class="radio-option">
            <input id="modalPasswordSelect" v-model="modalPasswordMode" type="radio" name="modalPasswordMode" value="select" />
            <label for="modalPasswordSelect">从常用密码选择</label>
          </div>
          <div class="radio-option">
            <input id="modalPasswordManual" v-model="modalPasswordMode" type="radio" name="modalPasswordMode" value="manual" />
            <label for="modalPasswordManual">本次手动输入</label>
          </div>
          <div class="radio-option">
            <input id="modalPasswordTryList" v-model="modalPasswordMode" type="radio" name="modalPasswordMode" value="try_list" />
            <label for="modalPasswordTryList">挨个尝试常用密码</label>
          </div>
        </div>

        <div id="modalPasswordSelectGroup" style="margin-top: 10px;" v-show="modalPasswordMode === 'select'">
          <select id="modalPasswordSelectDropdown" v-model.number="modalPasswordSelect" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
            <option value="">请选择密码</option>
            <option v-for="(pwd, index) in settingsDraft.commonPasswords" :key="`${index}-${pwd}`" :value="index">
              {{ getPasswordPreview(pwd) }} (#{{ index + 1 }})
            </option>
          </select>
        </div>

        <div id="modalPasswordManualGroup" style="margin-top: 10px;" v-show="modalPasswordMode === 'manual'">
          <input id="modalPasswordManualInput" v-model="modalPasswordManual" type="password" placeholder="输入解压密码" />
        </div>

        <div
          id="modalPasswordTryListHint"
          style="margin-top: 10px; padding: 8px; background: #e7f3ff; border-radius: 4px; font-size: 13px; color: #666;"
          v-show="modalPasswordMode === 'try_list'"
        >
          将按常用密码顺序依次尝试，直到成功或全部失败
        </div>
      </div>

      <div class="form-group">
        <label>冲突策略</label>
        <div class="radio-group">
          <div class="radio-option">
            <input id="modalConflictSkip" v-model="modalConflictPolicy" type="radio" name="modalConflict" value="skip" disabled />
            <label for="modalConflictSkip">跳过 - 如果目标已存在则跳过该文件</label>
          </div>
          <div class="radio-option">
            <input id="modalConflictOverwrite" v-model="modalConflictPolicy" type="radio" name="modalConflict" value="overwrite" disabled />
            <label for="modalConflictOverwrite">覆盖 - 如果目标已存在则覆盖</label>
          </div>
          <div class="radio-option">
            <input id="modalConflictRename" v-model="modalConflictPolicy" type="radio" name="modalConflict" value="rename" disabled />
            <label for="modalConflictRename">重命名 - 如果目标已存在则自动重命名</label>
          </div>
        </div>
        <div class="disabled-hint">冲突策略来自已保存设置，请在设置页面修改</div>
      </div>

      <div id="configModalStatus" class="status" v-show="status.configModal.visible" :class="statusClass(status.configModal)">
        {{ status.configModal.message }}
      </div>

      <div class="config-modal-footer">
        <button id="cancelConfigBtn" class="btn btn-secondary" @click="closeConfigModal">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
          取消
        </button>
        <button id="confirmConfigBtn" class="btn" :disabled="createJobInProgress" @click="confirmCreateJob">
          <i class="bi bi-check-lg" aria-hidden="true"></i>
          <span class="btn-label">{{ createJobInProgress ? '创建中...' : '确认开始' }}</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Directory Selector Modal -->
  <div
    id="dirSelectorModal"
    v-show="dirSelectorOpen"
    style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center;"
  >
    <div style="background: white; padding: 30px; border-radius: 8px; max-width: 600px; width: 90%; height: 80vh; box-shadow: 0 4px 20px rgba(0,0,0,0.3); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h2 style="margin: 0;">选择目录</h2>
        <button id="closeDirSelector" class="btn btn-icon" aria-label="关闭" @click="hideDirSelector">&times;</button>
      </div>

      <div style="display: flex; gap: 10px; margin-bottom: 15px; align-items: center;">
        <button id="dirSelectorGoRoot" class="btn btn-secondary" @click="loadDirRoots">根目录</button>
        <button id="dirSelectorGoUp" class="btn btn-secondary" @click="goToParentDir">上一级</button>
        <div style="flex: 1; text-align: right; font-size: 13px; color: #666;">当前路径: <span id="dirSelectorCurrentPath">{{ currentDirPathLabel }}</span></div>
      </div>

      <div id="dirSelectorLoading" v-show="dirSelectorLoading" style="text-align: center; padding: 10px;">加载中...</div>
      <div id="dirSelectorError" v-show="dirSelectorError" style="color: #e74c3c; padding: 10px;">{{ dirSelectorError }}</div>

      <div id="dirSelectorList" style="flex: 1; min-height: 0; overflow-y: auto; border: 1px solid #eee; border-radius: 4px;">
        <div v-if="dirSelectorItems.length === 0 && !dirSelectorLoading" style="text-align: center; padding: 20px; color: #999;">
          {{ dirSelectorEmptyText }}
        </div>
        <div
          v-for="item in dirSelectorItems"
          :key="item.path"
          class="dir-item"
          :data-path="item.path"
          style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; display: flex; align-items: center; gap: 10px;"
          @click="loadDirList(item.path)"
        >
          <span style="font-size: 18px;">📁</span>
          <span style="flex: 1;">{{ item.name }}</span>
        </div>
      </div>

      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 15px;">
        <button id="dirSelectorCancel" class="btn btn-secondary" @click="hideDirSelector">取消</button>
        <button id="dirSelectorConfirm" class="btn" @click="selectCurrentDir">选择此目录</button>
      </div>
    </div>
  </div>

  <!-- Retry Job Modal -->
  <div
    id="retryJobModal"
    v-show="retryModalOpen"
    style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center;"
    @click.self="closeRetryModal"
  >
    <div style="background: white; padding: 30px; border-radius: 8px; max-width: 500px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h2 style="margin: 0;">重试任务</h2>
        <button id="closeRetryModal" class="btn btn-icon" aria-label="关闭" @click="closeRetryModal">&times;</button>
      </div>

      <div id="retryJobError" class="error-banner" v-show="retryJobError" style="display: block;">{{ retryJobError }}</div>

      <div class="form-group">
        <label>解压密码</label>
        <div class="radio-group">
          <div class="radio-option">
            <input id="retryPasswordNone" v-model="retryPasswordMode" type="radio" name="retryPasswordMode" value="none" />
            <label for="retryPasswordNone">不使用密码</label>
          </div>
          <div class="radio-option">
            <input id="retryPasswordSelect" v-model="retryPasswordMode" type="radio" name="retryPasswordMode" value="select" />
            <label for="retryPasswordSelect">从常用密码选择</label>
          </div>
          <div class="radio-option">
            <input id="retryPasswordManual" v-model="retryPasswordMode" type="radio" name="retryPasswordMode" value="manual" />
            <label for="retryPasswordManual">本次手动输入</label>
          </div>
          <div class="radio-option">
            <input id="retryPasswordTryList" v-model="retryPasswordMode" type="radio" name="retryPasswordMode" value="try_list" />
            <label for="retryPasswordTryList">挨个尝试常用密码</label>
          </div>
        </div>

        <div id="retryPasswordSelectGroup" style="margin-top: 10px;" v-show="retryPasswordMode === 'select'">
          <select id="retryPasswordSelectDropdown" v-model.number="retryPasswordSelect" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
            <option value="">请选择密码</option>
            <option v-for="(pwd, index) in settingsDraft.commonPasswords" :key="`${index}-${pwd}`" :value="index">
              {{ getPasswordPreview(pwd) }} (#{{ index + 1 }})
            </option>
          </select>
        </div>

        <div id="retryPasswordManualGroup" style="margin-top: 10px;" v-show="retryPasswordMode === 'manual'">
          <input id="retryPasswordManualInput" v-model="retryPasswordManual" type="password" placeholder="输入解压密码" />
        </div>

        <div
          id="retryPasswordTryListHint"
          style="margin-top: 10px; padding: 8px; background: #e7f3ff; border-radius: 4px; font-size: 13px; color: #666;"
          v-show="retryPasswordMode === 'try_list'"
        >
          将按常用密码顺序依次尝试，直到成功或全部失败
        </div>
      </div>

      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
        <button id="cancelRetryBtn" class="btn btn-secondary" @click="closeRetryModal">取消</button>
        <button id="confirmRetryBtn" class="btn" :disabled="retrySubmitting" @click="confirmRetry">
          {{ retrySubmitting ? '重试中...' : '确认重试' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Zip Slip Confirm Modal -->
  <div
    id="zipSlipConfirmModal"
    v-show="zipSlipConfirmOpen"
    style="display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; align-items: center; justify-content: center;"
    @click.self="cancelZipSlipAllow"
  >
    <div style="background: white; padding: 24px; border-radius: 8px; max-width: 520px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2 style="margin: 0;">安全警告</h2>
        <button class="btn btn-icon" aria-label="关闭" @click="cancelZipSlipAllow">&times;</button>
      </div>
      <div style="font-size: 14px; line-height: 1.6; color: #333;">
        开启“允许路径穿越”存在安全风险，可能导致文件被解压到目标目录之外，甚至覆盖系统文件。
        <br />
        确定要继续吗？
      </div>
      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;">
        <button class="btn btn-secondary" @click="cancelZipSlipAllow">取消</button>
        <button class="btn" @click="confirmZipSlipAllow">确认开启</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';

type ConflictPolicy = 'skip' | 'overwrite' | 'rename';
type OutputMode = 'sibling_named_dir' | 'in_place' | 'custom';
type ZipSlipPolicy = 'block' | 'allow';
type PasswordMode = 'none' | 'select' | 'manual' | 'try_list';

type StatusKey = 'scan' | 'createJob' | 'settings' | 'configModal';

interface StatusState {
  message: string;
  isError: boolean;
  visible: boolean;
}

interface Settings {
  conflict: ConflictPolicy;
  outputMode: OutputMode;
  zipSlipPolicy: ZipSlipPolicy;
  commonPasswords?: string[];
  passwordMasking?: boolean;
  updatedAt: number;
}

interface ScanItem {
  path: string;
  size: number;
  mtimeMs: number;
  ext: string;
}

interface JobRow {
  id: number;
  status: string;
  root_path: string;
  output_mode: OutputMode;
  output_dir?: string | null;
  conflict_policy: ConflictPolicy;
  created_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  canceled: number;
  last_error?: string | null;
  retry_from_job_id?: number | null;
}

interface JobItemRow {
  id: number;
  status: string;
  archive_path: string;
  out_dir?: string | null;
  failed_detail?: string | null;
  started_at?: number | null;
  ended_at?: number | null;
}

interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

const API_BASE = '/api';
const DEFAULT_SETTINGS = {
  conflict: 'skip' as ConflictPolicy,
  outputMode: 'sibling_named_dir' as OutputMode,
  zipSlipPolicy: 'block' as ZipSlipPolicy
};

const currentPage = ref<'home' | 'settings' | 'detail'>('home');
const currentJobId = ref<number | null>(null);
const rootPath = ref('');
const selectedFiles = ref<ScanItem[]>([]);
const scanInProgress = ref(false);
const jobs = ref<JobRow[]>([]);
const jobLogCache = reactive<Record<number, string>>({});
const expandedLogs = ref<Set<number>>(new Set());
const isBackendHealthy = ref(false);
const versionText = ref('loading...');
const toastVisible = ref(false);

const status: Record<StatusKey, StatusState> = reactive({
  scan: { message: '', isError: false, visible: false },
  createJob: { message: '', isError: false, visible: false },
  settings: { message: '', isError: false, visible: false },
  configModal: { message: '', isError: false, visible: false }
});

const statusTimers: Partial<Record<StatusKey, number>> = {};

const settingsDraft = reactive({
  conflict: DEFAULT_SETTINGS.conflict,
  outputMode: DEFAULT_SETTINGS.outputMode,
  zipSlipPolicy: DEFAULT_SETTINGS.zipSlipPolicy,
  commonPasswords: [] as string[]
});

const currentSettings = ref<Settings | null>(null);
const newPassword = ref('');
const passwordReveal = reactive<Record<number, boolean>>({});
const passwordRevealTimers = new Map<number, number>();

const settingsSaveStatus = ref('');
const settingsSaveStatusColor = ref('#666');
const settingsSaveStatusClickable = ref(false);
const zipSlipChecked = ref(false);

const autoSaveTimer = ref<number | null>(null);
const isSaving = ref(false);
const pendingSave = ref<{
  conflict: ConflictPolicy;
  outputMode: OutputMode;
  zipSlipPolicy: ZipSlipPolicy;
  commonPasswords: string[];
} | null>(null);
const saveRequestId = ref(0);

const configModalOpen = ref(false);
const createJobInProgress = ref(false);
const modalPasswordMode = ref<PasswordMode>('none');
const modalPasswordSelect = ref<number | ''>('');
const modalPasswordManual = ref('');
const modalConflictPolicy = ref<ConflictPolicy>('skip');

const dirSelectorOpen = ref(false);
const dirSelectorLoading = ref(false);
const dirSelectorError = ref('');
const dirSelectorItems = ref<DirEntry[]>([]);
const currentDirPath = ref('/');
const dirSelectorMode = ref<'roots' | 'list'>('roots');

const retryModalOpen = ref(false);
const currentRetryJobId = ref<number | null>(null);
const retryPasswordMode = ref<PasswordMode>('none');
const retryPasswordSelect = ref<number | ''>('');
const retryPasswordManual = ref('');
const retryJobError = ref('');
const retrySubmitting = ref(false);
const zipSlipConfirmOpen = ref(false);

const jobDetailData = ref<{ job: JobRow; items: JobItemRow[] } | null>(null);
const jobDetailError = ref('');
const jobDetailAutoRefresh = ref(true);
const jobDetailRefreshInterval = ref(2000);
const jobDetailFilterFailed = ref(false);
let pollInterval: number | null = null;
let jobDetailPollInterval: number | null = null;

const darkMode = ref(false);

const limitedFiles = computed(() => selectedFiles.value.slice(0, 100));

const jobDetailItems = computed(() => {
  if (!jobDetailData.value) return [];
  if (!jobDetailFilterFailed.value) return jobDetailData.value.items;
  return jobDetailData.value.items.filter((item) => item.status === 'failed');
});

const jobDetailProgress = computed(() => {
  if (!jobDetailData.value) return { percent: 0, label: '0%' };
  const total = jobDetailData.value.job.total || 0;
  const done = (jobDetailData.value.job.success || 0)
    + (jobDetailData.value.job.failed || 0)
    + (jobDetailData.value.job.skipped || 0)
    + (jobDetailData.value.job.canceled || 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return { percent, label: `${percent}% (${done}/${total})` };
});

const jobDetailEndedText = computed(() => {
  if (!jobDetailData.value) return '-';
  const job = jobDetailData.value.job;
  if (job.ended_at) return formatTime(job.ended_at);
  if (job.started_at) {
    const elapsed = Math.floor((Date.now() - job.started_at) / 1000);
    return `运行中... (已运行 ${elapsed} 秒)`;
  }
  return '-';
});

const darkModeText = computed(() => (darkMode.value ? '浅色模式' : '暗黑模式'));
const darkModeIcon = computed(() => (darkMode.value ? '☀️' : '🌙'));

const currentDirPathLabel = computed(() => (dirSelectorMode.value === 'roots' ? 'Root' : currentDirPath.value));
const dirSelectorEmptyText = computed(() => (dirSelectorMode.value === 'roots' ? '没有可访问的根目录' : '此目录为空'));

function statusClass(state: StatusState): string {
  return `status ${state.isError ? 'error' : 'success'}`;
}

function showStatus(key: StatusKey, message: string, isError = false): void {
  status[key].message = message;
  status[key].isError = isError;
  status[key].visible = true;

  if (statusTimers[key]) {
    clearTimeout(statusTimers[key]);
  }

  statusTimers[key] = window.setTimeout(() => {
    status[key].visible = false;
  }, 5000);
}

function goHome(): void {
  window.location.hash = '';
  currentPage.value = 'home';
  stopJobDetailPolling();
  if (isBackendHealthy.value) {
    startPolling();
  }
}

function goSettings(): void {
  window.location.hash = 'settings';
  currentPage.value = 'settings';
  stopPolling();
  stopJobDetailPolling();
  loadSettings();
}

function handleRoute(): void {
  const hash = window.location.hash;
  if (hash === '#settings') {
    currentPage.value = 'settings';
    stopPolling();
    stopJobDetailPolling();
    loadSettings();
    return;
  }

  if (hash.startsWith('#jobs/')) {
    const jobIdStr = hash.substring(6);
    if (jobIdStr && /^\d+$/.test(jobIdStr)) {
      currentPage.value = 'detail';
      stopPolling();
      loadJobDetail(parseInt(jobIdStr, 10));
      return;
    }
  }

  currentPage.value = 'home';
  stopJobDetailPolling();
  if (isBackendHealthy.value) {
    startPolling();
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    isBackendHealthy.value = !!data.ok;
    return data.ok;
  } catch (err) {
    console.error('Health check failed:', err);
    isBackendHealthy.value = false;
    return false;
  }
}

async function loadSettings(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    const data = await res.json();

    if (data.error) {
      showStatus('settings', `加载设置失败: ${data.error}`, true);
      return;
    }

    if (!data) {
      currentSettings.value = null;
      settingsDraft.conflict = DEFAULT_SETTINGS.conflict;
      settingsDraft.outputMode = DEFAULT_SETTINGS.outputMode;
      settingsDraft.zipSlipPolicy = DEFAULT_SETTINGS.zipSlipPolicy;
      settingsDraft.commonPasswords = [];
      showStatus('settings', '设置未配置，请完成配置后保存', false);
      return;
    }

    currentSettings.value = data;
    applySettingsToForm(data);
  } catch (err: any) {
    showStatus('settings', `加载设置失败: ${err.message}`, true);
  }
}

function applySettingsToForm(settings: Settings): void {
  settingsDraft.conflict = settings.conflict;
  settingsDraft.outputMode = settings.outputMode;
  settingsDraft.zipSlipPolicy = settings.zipSlipPolicy;
  settingsDraft.commonPasswords = settings.commonPasswords ? [...settings.commonPasswords] : [];
  zipSlipChecked.value = settings.zipSlipPolicy === 'allow';
  Object.keys(passwordReveal).forEach((key) => {
    delete passwordReveal[Number(key)];
  });
}

function getPasswordPreview(password: string, previewLen = 4): string {
  if (!password) return '••••';
  const prefix = password.slice(0, Math.min(previewLen, password.length));
  return `${prefix}••••`;
}

function getPasswordPreviewForLog(password: string, index: number, previewLen = 4): string {
  return `${getPasswordPreview(password, previewLen)}(#${index + 1})`;
}

function togglePasswordReveal(index: number): void {
  const currentlyRevealed = !!passwordReveal[index];
  passwordReveal[index] = !currentlyRevealed;

  if (!currentlyRevealed) {
    if (passwordRevealTimers.has(index)) {
      clearTimeout(passwordRevealTimers.get(index));
    }
    const timerId = window.setTimeout(() => {
      passwordReveal[index] = false;
    }, 3000);
    passwordRevealTimers.set(index, timerId);
  }
}

function addPassword(): void {
  const pwd = newPassword.value.trim();
  if (!pwd) {
    showStatus('settings', '请输入密码', true);
    return;
  }
  settingsDraft.commonPasswords.push(pwd);
  newPassword.value = '';
  const previews = settingsDraft.commonPasswords.map((p, i) => getPasswordPreviewForLog(p, i));
  console.log('[settings] Added password, current count:', settingsDraft.commonPasswords.length, 'previews:', previews);
  scheduleAutoSave();
}

function removePassword(index: number): void {
  settingsDraft.commonPasswords.splice(index, 1);
  scheduleAutoSave();
}

function movePassword(index: number, delta: number): void {
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= settingsDraft.commonPasswords.length) return;
  const temp = settingsDraft.commonPasswords[index];
  settingsDraft.commonPasswords[index] = settingsDraft.commonPasswords[newIndex];
  settingsDraft.commonPasswords[newIndex] = temp;
  scheduleAutoSave();
}

function handleZipSlipChange(event: Event): void {
  const wantsAllow = zipSlipChecked.value;
  if (wantsAllow) {
    settingsDraft.zipSlipPolicy = 'block';
    zipSlipChecked.value = false;
    zipSlipConfirmOpen.value = true;
    return;
  }

  settingsDraft.zipSlipPolicy = 'block';
  scheduleAutoSave();
}

function confirmZipSlipAllow(): void {
  zipSlipConfirmOpen.value = false;
  settingsDraft.zipSlipPolicy = 'allow';
  zipSlipChecked.value = true;
  showStatus('settings', '已启用危险选项（未自动保存），请确认设置是否需要保存。', false);
  scheduleAutoSave();
}

function cancelZipSlipAllow(): void {
  zipSlipConfirmOpen.value = false;
  settingsDraft.zipSlipPolicy = 'block';
  zipSlipChecked.value = false;
}

function scheduleAutoSave(): void {
  if (autoSaveTimer.value) {
    clearTimeout(autoSaveTimer.value);
  }

  pendingSave.value = {
    conflict: settingsDraft.conflict,
    outputMode: settingsDraft.outputMode,
    zipSlipPolicy: settingsDraft.zipSlipPolicy,
    commonPasswords: [...settingsDraft.commonPasswords]
  };

  autoSaveTimer.value = window.setTimeout(() => {
    performAutoSave();
  }, 500);
}

function retryAutoSave(): void {
  scheduleAutoSave();
  setTimeout(() => performAutoSave(), 100);
}

async function performAutoSave(): Promise<void> {
  if (isSaving.value || !pendingSave.value) return;

  isSaving.value = true;
  const currentRequestId = ++saveRequestId.value;
  const saveData = { ...pendingSave.value };
  pendingSave.value = null;

  settingsSaveStatus.value = '保存中...';
  settingsSaveStatusColor.value = '#666';
  settingsSaveStatusClickable.value = false;

  try {
    const previews = (saveData.commonPasswords || []).map((p, i) => getPasswordPreviewForLog(p, i));
    console.log('[settings] auto-save payload', {
      conflict: saveData.conflict,
      outputMode: saveData.outputMode,
      zipSlipPolicy: saveData.zipSlipPolicy,
      commonPasswordsCount: (saveData.commonPasswords || []).length,
      commonPasswordsPreview: previews
    });

    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(saveData)
    });

    const data = await res.json();

    if (currentRequestId !== saveRequestId.value) {
      console.log('[settings] Ignoring outdated save response');
      return;
    }

    console.log('[settings] auto-save response', {
      status: res.status,
      ok: res.ok,
      requestId: currentRequestId,
      error: data.error || null
    });

    if (!res.ok || data.error) {
      throw new Error(data.error || 'Unknown error');
    }

    currentSettings.value = data;
    settingsDraft.commonPasswords = data.commonPasswords ? [...data.commonPasswords] : [];

    settingsSaveStatus.value = '已自动保存';
    settingsSaveStatusColor.value = '#28a745';
    settingsSaveStatusClickable.value = false;

    setTimeout(() => {
      if (settingsSaveStatus.value === '已自动保存') {
        settingsSaveStatus.value = '';
      }
    }, 2000);

    if (pendingSave.value) {
      setTimeout(() => performAutoSave(), 100);
    }
  } catch (err: any) {
    console.error('[settings] auto-save error:', err);
    if (currentRequestId === saveRequestId.value) {
      settingsSaveStatus.value = '保存失败，点击重试';
      settingsSaveStatusColor.value = '#e74c3c';
      settingsSaveStatusClickable.value = true;
      showStatus('settings', `保存失败: ${err.message}`, true);
    }
  } finally {
    if (currentRequestId === saveRequestId.value) {
      isSaving.value = false;
    }
  }
}

function resetSettings(): void {
  settingsDraft.commonPasswords = [];
  settingsDraft.conflict = DEFAULT_SETTINGS.conflict;
  settingsDraft.outputMode = DEFAULT_SETTINGS.outputMode;
  settingsDraft.zipSlipPolicy = DEFAULT_SETTINGS.zipSlipPolicy;
  zipSlipChecked.value = false;
  showStatus('settings', '已重置为默认值（未保存）', false);
}

async function scanDirectory(): Promise<void> {
  if (!rootPath.value.trim()) {
    showStatus('scan', '请输入目录路径', true);
    return;
  }

  scanInProgress.value = true;

  try {
    const res = await fetch(`${API_BASE}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootPath: rootPath.value.trim(),
        recursive: true,
        exts: ['.zip', '.cbz'],
        ignoreDirs: ['@eaDir', '#recycle', '.Trash']
      })
    });

    const data = await res.json();

    if (data.error) {
      showStatus('scan', data.error, true);
      return;
    }

    selectedFiles.value = data.items || [];
    showStatus('scan', `找到 ${data.total} 个文件${data.truncated ? ' (已截断，超过5000个)' : ''}`);
  } catch (err: any) {
    showStatus('scan', `扫描失败: ${err.message}`, true);
  } finally {
    scanInProgress.value = false;
  }
}

function openConfigModal(): void {
  if (selectedFiles.value.length === 0) {
    showStatus('createJob', '请先扫描文件', true);
    return;
  }
  if (!rootPath.value.trim()) {
    showStatus('createJob', '请输入目录路径', true);
    return;
  }
  configModalOpen.value = true;
  modalPasswordMode.value = 'none';
  modalPasswordSelect.value = '';
  modalPasswordManual.value = '';
  loadSettingsForModal();
}

function closeConfigModal(): void {
  configModalOpen.value = false;
}

async function loadSettingsForModal(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    const data = await res.json();
    if (data && data !== null) {
      currentSettings.value = data;
      modalConflictPolicy.value = data.conflict || 'skip';
      settingsDraft.commonPasswords = data.commonPasswords ? [...data.commonPasswords] : [];
    } else {
      modalConflictPolicy.value = 'skip';
    }
  } catch (err) {
    console.error('Failed to load settings for modal:', err);
    modalConflictPolicy.value = 'skip';
  }
}

async function confirmCreateJob(): Promise<void> {
  if (selectedFiles.value.length === 0) {
    showStatus('configModal', '请先扫描文件', true);
    return;
  }
  if (!rootPath.value.trim()) {
    showStatus('configModal', '请输入目录路径', true);
    return;
  }

  let settings: Settings | null = null;
  try {
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (!settingsRes.ok) {
      showStatus('configModal', '无法加载设置，请先配置任务选项', true);
      return;
    }
    settings = await settingsRes.json();
  } catch (err) {
    console.error('Failed to load settings:', err);
    showStatus('configModal', '无法加载设置，请先配置任务选项', true);
    return;
  }

  if (!settings || typeof settings !== 'object') {
    showStatus('configModal', '设置未配置，请先前往设置页面完成配置并保存', true);
    return;
  }

  const missingFields: string[] = [];
  if (!settings.conflict) missingFields.push('conflictPolicy (冲突策略)');
  if (!settings.outputMode) missingFields.push('outputMode (输出方式)');
  if (!settings.zipSlipPolicy) missingFields.push('zipSlipPolicy (路径穿越策略)');

  if (missingFields.length > 0) {
    showStatus('configModal', `设置不完整，缺少必填字段：${missingFields.join('、')}。请前往设置页面完成配置并保存。`, true);
    return;
  }

  const jobOptions: Record<string, any> = {
    conflictPolicy: settings.conflict,
    outputMode: settings.outputMode,
    zipSlipPolicy: settings.zipSlipPolicy
  };

  if (modalPasswordMode.value !== 'none') {
    jobOptions.passwordMode = modalPasswordMode.value;

    if (modalPasswordMode.value === 'select') {
      const passwordRefIndex = typeof modalPasswordSelect.value === 'number' ? modalPasswordSelect.value : NaN;
      if (Number.isNaN(passwordRefIndex) || passwordRefIndex < 0) {
        showStatus('configModal', '请选择常用密码', true);
        return;
      }
      jobOptions.passwordRefIndex = passwordRefIndex;
      const selectedPwd = settings.commonPasswords?.[passwordRefIndex];
      if (selectedPwd) {
        const preview = getPasswordPreview(selectedPwd);
        console.log('[job] Selected password preview:', `${preview} (#${passwordRefIndex + 1})`);
      }
    } else if (modalPasswordMode.value === 'manual') {
      const passwordValue = modalPasswordManual.value.trim();
      if (!passwordValue) {
        showStatus('configModal', '请输入解压密码', true);
        return;
      }
      jobOptions.passwordValue = passwordValue;
    } else if (modalPasswordMode.value === 'try_list') {
      const commonPasswords = settings.commonPasswords || [];
      if (commonPasswords.length === 0) {
        showStatus('configModal', '常用密码列表为空，请前往设置页面添加密码', true);
        return;
      }
      jobOptions.passwordTryOrder = 'as_is';
    }
  }

  createJobInProgress.value = true;

  try {
    const res = await fetch(`${API_BASE}/job-submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootPath: rootPath.value.trim(),
        items: selectedFiles.value.map((f) => f.path),
        jobOptions
      })
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      let errorMsg = data.error || 'Unknown error';
      if (data.missing && Array.isArray(data.missing)) {
        errorMsg = `缺少必填字段: ${data.missing.join(', ')}`;
      } else if (data.message) {
        errorMsg = data.message;
      }
      showStatus('configModal', errorMsg, true);
      return;
    }

    showStatus('createJob', `任务创建成功，ID: ${data.jobId}`);
    closeConfigModal();
    startPolling();
  } catch (err: any) {
    showStatus('configModal', `创建失败: ${err.message}`, true);
  } finally {
    createJobInProgress.value = false;
  }
}

async function fetchJobs(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/jobs`);
    const data = await res.json();
    if (data.error) {
      console.error('Fetch jobs error:', data.error);
      return;
    }
    jobs.value = data.jobs || [];
    await refreshExpandedLogs(jobs.value);
  } catch (err) {
    console.error('Fetch jobs failed:', err);
  }
}

function startPolling(): void {
  if (pollInterval) return;
  fetchJobs();
  pollInterval = window.setInterval(fetchJobs, 2000);
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function isJobDeletable(status: string): boolean {
  return ['completed', 'failed', 'canceled'].includes(status);
}

function jobProgress(job: JobRow): number {
  const total = job.total || 0;
  const done = (job.success || 0) + (job.failed || 0) + (job.skipped || 0) + (job.canceled || 0);
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function retryFromText(job: JobRow): string {
  return job.retry_from_job_id ? ` (重试自任务 #${job.retry_from_job_id})` : '';
}

function jobLogContent(jobId: number): string {
  if (jobLogCache[jobId]) return jobLogCache[jobId];
  if (expandedLogs.value.has(jobId)) return 'Loading log...';
  return '';
}

async function toggleJobLogs(job: JobRow): Promise<void> {
  const next = new Set(expandedLogs.value);
  if (next.has(job.id)) {
    next.delete(job.id);
    expandedLogs.value = next;
    return;
  }

  next.add(job.id);
  expandedLogs.value = next;

  await refreshExpandedLogs([job]);
}

async function refreshExpandedLogs(currentJobs: JobRow[]): Promise<void> {
  const expanded = expandedLogs.value;
  if (expanded.size === 0) return;

  for (const job of currentJobs) {
    if (!expanded.has(job.id)) continue;

    const isJobFinished = ['completed', 'failed', 'canceled'].includes(job.status);
    if (isJobFinished && jobLogCache[job.id]) continue;

    try {
      const res = await fetch(`${API_BASE}/jobs/${job.id}/log`);
      const data = await res.json();
      if (res.ok && data.content !== undefined) {
        jobLogCache[job.id] = data.content || 'No log available';
      } else {
        jobLogCache[job.id] = data.error || 'No log available';
      }
    } catch (err: any) {
      jobLogCache[job.id] = `Failed to load log: ${err.message}`;
    }
  }
}

async function deleteJob(jobId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.message || data.error || '删除失败') as Error & { status?: number };
    (error as any).status = res.status;
    throw error;
  }
}

async function handleDeleteJob(jobId: number): Promise<void> {
  if (!confirm(`确认删除任务 #${jobId}？\n仅删除记录，不会删除已解压的文件。`)) return;

  try {
    await deleteJob(jobId);
    showStatus('createJob', `任务 #${jobId} 已删除`, false);
    await fetchJobs();
  } catch (err: any) {
    showStatus('createJob', err.message || '删除失败', true);
    if (err.status === 404) {
      await fetchJobs();
    }
  }
}

async function clearFailedJobs(): Promise<{ deletedCount: number }>{
  const res = await fetch(`${API_BASE}/jobs/clear-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.message || data.error || '清除失败') as Error & { status?: number };
    (error as any).status = res.status;
    throw error;
  }
  return data;
}

async function handleClearFailed(): Promise<void> {
  if (!confirm('确认清除所有失败任务？\n将删除所有 failed 状态任务，无法恢复。\n仅删除记录，不会删除已解压的文件。')) {
    return;
  }
  try {
    const result = await clearFailedJobs();
    showStatus('createJob', `已清除 ${result.deletedCount || 0} 个失败任务`, false);
    await fetchJobs();
  } catch (err: any) {
    showStatus('createJob', err.message || '清除失败', true);
  }
}

async function handleRetryJob(jobId: number): Promise<void> {
  try {
    const settingsRes = await fetch(`${API_BASE}/settings`);
    if (settingsRes.ok) {
      const data = await settingsRes.json();
      currentSettings.value = data;
      settingsDraft.commonPasswords = data.commonPasswords ? [...data.commonPasswords] : [];
    }
  } catch (err) {
    console.error('Failed to load settings for retry:', err);
  }
  openRetryModal(jobId);
}

function openRetryModal(jobId: number): void {
  currentRetryJobId.value = jobId;
  retryModalOpen.value = true;
  retryPasswordMode.value = 'none';
  retryPasswordSelect.value = '';
  retryPasswordManual.value = '';
  retryJobError.value = '';
}

function closeRetryModal(): void {
  retryModalOpen.value = false;
  currentRetryJobId.value = null;
}

async function confirmRetry(): Promise<void> {
  if (!currentRetryJobId.value) return;

  retryJobError.value = '';

  const retryBody: Record<string, any> = { passwordMode: retryPasswordMode.value };

  if (retryPasswordMode.value === 'select') {
    const passwordRefIndex = typeof retryPasswordSelect.value === 'number' ? retryPasswordSelect.value : NaN;
    if (Number.isNaN(passwordRefIndex) || passwordRefIndex < 0) {
      retryJobError.value = '请选择常用密码';
      return;
    }
    retryBody.passwordRefIndex = passwordRefIndex;
    const selectedPwd = settingsDraft.commonPasswords[passwordRefIndex];
    if (selectedPwd) {
      const preview = getPasswordPreview(selectedPwd);
      console.log('[retry] Selected password preview:', `${preview} (#${passwordRefIndex + 1})`);
    }
  } else if (retryPasswordMode.value === 'manual') {
    const passwordValue = retryPasswordManual.value.trim();
    if (!passwordValue) {
      retryJobError.value = '请输入解压密码';
      return;
    }
    retryBody.passwordValue = passwordValue;
  } else if (retryPasswordMode.value === 'try_list') {
    if (settingsDraft.commonPasswords.length === 0) {
      retryJobError.value = '常用密码列表为空，请前往设置页面添加密码';
      return;
    }
  }

  retrySubmitting.value = true;

  try {
    const res = await fetch(`${API_BASE}/jobs/${currentRetryJobId.value}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retryBody)
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      retryJobError.value = data.error || data.message || '重试失败';
      return;
    }

    closeRetryModal();
    showStatus('createJob', `已创建重试任务 #${data.jobId}`, false);
    await fetchJobs();
  } catch (err: any) {
    retryJobError.value = `重试失败: ${err.message}`;
  } finally {
    retrySubmitting.value = false;
  }
}

function showDirSelector(): void {
  dirSelectorOpen.value = true;
  currentDirPath.value = '/';
  loadDirRoots();
}

function hideDirSelector(): void {
  dirSelectorOpen.value = false;
}

async function loadDirRoots(): Promise<void> {
  if (dirSelectorLoading.value) return;
  dirSelectorLoading.value = true;
  dirSelectorError.value = '';
  dirSelectorItems.value = [];
  dirSelectorMode.value = 'roots';

  try {
    const res = await fetch(`${API_BASE}/fs/roots`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.roots && data.roots.length > 0) {
      const sortedRoots = [...data.roots].sort((a: any, b: any) => {
        const sourcePriority: Record<string, number> = { 'data-share': 0, 'trim': 1, 'probe': 2, 'fallback': 3 };
        const priorityA = sourcePriority[a.source] ?? 99;
        const priorityB = sourcePriority[b.source] ?? 99;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.path.localeCompare(b.path);
      });
      dirSelectorItems.value = sortedRoots.map((root: any) => ({
        name: root.label || root.path,
        path: root.path,
        isDir: true,
        size: 0,
        mtime: ''
      }));
      currentDirPath.value = '/';
    } else {
      dirSelectorItems.value = [];
    }
  } catch (err: any) {
    dirSelectorError.value = `加载失败: ${err.message}`;
  } finally {
    dirSelectorLoading.value = false;
  }
}

async function loadDirList(path: string): Promise<void> {
  if (dirSelectorLoading.value) return;
  dirSelectorLoading.value = true;
  dirSelectorError.value = '';
  dirSelectorItems.value = [];
  dirSelectorMode.value = 'list';

  try {
    const res = await fetch(`${API_BASE}/fs/list?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentDirPath.value = data.path || path;
    if (data.items && data.items.length > 0) {
      dirSelectorItems.value = (data.items as DirEntry[]).filter((item) => item.isDir);
    } else {
      dirSelectorItems.value = [];
    }
  } catch (err: any) {
    dirSelectorError.value = `加载失败: ${err.message}`;
  } finally {
    dirSelectorLoading.value = false;
  }
}

function goToParentDir(): void {
  if (currentDirPath.value === '/' || currentDirPath.value === '') {
    loadDirRoots();
    return;
  }
  const parentPath = getParentPath(currentDirPath.value);
  if (parentPath === currentDirPath.value) {
    loadDirRoots();
  } else {
    loadDirList(parentPath);
  }
}

function getParentPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((x) => x);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(0, -1).join('/')}`;
}

function selectCurrentDir(): void {
  rootPath.value = currentDirPath.value;
  hideDirSelector();
}

async function loadVersion(): Promise<void> {
  try {
    const res = await fetch('/version.json');
    if (res.ok) {
      const data = await res.json();
      versionText.value = data.version || 'unknown';
    } else {
      versionText.value = 'unknown';
    }
  } catch (err) {
    console.error('Failed to load version:', err);
    versionText.value = 'unknown';
  }
}

function initDarkMode(): void {
  const savedMode = localStorage.getItem('darkMode');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  darkMode.value = savedMode !== null ? savedMode === 'true' : prefersDark;
  applyDarkMode(darkMode.value);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('darkMode') === null) {
      applyDarkMode(e.matches);
    }
  });
}

function applyDarkMode(isDark: boolean): void {
  darkMode.value = isDark;
  if (isDark) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
}

function toggleDarkMode(): void {
  const newMode = !darkMode.value;
  applyDarkMode(newMode);
  localStorage.setItem('darkMode', newMode.toString());
}

async function loadJobDetail(jobId: number): Promise<void> {
  currentJobId.value = jobId;
  jobDetailError.value = '';

  try {
    const res = await fetch(`${API_BASE}/jobs/${jobId}`);
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error);
    }
    jobDetailData.value = data;
    if (jobDetailAutoRefresh.value) {
      startJobDetailPolling();
    }
  } catch (err: any) {
    jobDetailError.value = `加载失败: ${err.message}`;
    jobDetailData.value = null;
  }
}

function startJobDetailPolling(): void {
  stopJobDetailPolling();
  const interval = jobDetailRefreshInterval.value || 2000;
  jobDetailPollInterval = window.setInterval(async () => {
    if (!currentJobId.value) return;
    try {
      const res = await fetch(`${API_BASE}/jobs/${currentJobId.value}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      jobDetailData.value = data;

      const finalStates = ['completed', 'failed', 'canceled'];
      if (finalStates.includes(data.job.status)) {
        stopJobDetailPolling();
      }
    } catch (err: any) {
      jobDetailError.value = `刷新失败: ${err.message} (保留上次数据)`;
    }
  }, interval);
}

function stopJobDetailPolling(): void {
  if (jobDetailPollInterval) {
    clearInterval(jobDetailPollInterval);
    jobDetailPollInterval = null;
  }
}

function toggleJobDetailPolling(): void {
  if (jobDetailAutoRefresh.value) {
    startJobDetailPolling();
  } else {
    stopJobDetailPolling();
  }
}

function manualRefreshJobDetail(): void {
  if (currentJobId.value) {
    loadJobDetail(currentJobId.value);
  }
}

function showToast(): void {
  toastVisible.value = true;
  setTimeout(() => {
    toastVisible.value = false;
  }, 2000);
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(showToast).catch((err) => {
    console.error('Copy failed:', err);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function getStatusText(status: string): string {
  const map: Record<string, string> = {
    pending: '等待中',
    running: '运行中',
    success: '成功',
    failed: '失败',
    skipped: '跳过',
    canceled: '已取消',
    completed: '已完成',
    paused: '已暂停',
    draft: '草稿',
    queued: '队列中',
    pausing: '暂停中',
    canceling: '取消中'
  };
  return map[status] || status;
}

function truncatePath(fullPath: string): string {
  if (!fullPath) return '-';
  return fullPath.length > 50 ? `${fullPath.substring(0, 47)}...` : fullPath;
}

function formatDuration(started?: number | null, ended?: number | null): string {
  if (!started || !ended) return '-';
  const ms = ended - started;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

onMounted(async () => {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();

  initDarkMode();
  await loadVersion();

  const ok = await checkHealth();
  const isHomeRoute = !window.location.hash || window.location.hash === '#';
  if (ok && isHomeRoute) {
    startPolling();
  } else if (!ok) {
    showStatus('scan', '无法连接到服务器，请检查服务是否运行', true);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', handleRoute);
  stopPolling();
  stopJobDetailPolling();
});
</script>
