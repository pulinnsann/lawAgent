/** Native dialogs use the same explicit interface language as the renderer.
 * These labels never translate paths, filenames supplied by users, or contracts. */
export type InterfaceLanguage = 'zh' | 'en' | 'th';
const labels: Record<string, { en: string; th: string }> = {
  '合同工作台': { en: 'Contract Workbench', th: 'พื้นที่ทำงานสัญญา' },
  '导入合同': { en: 'Import contract', th: 'นำเข้าสัญญา' },
  '合同文档': { en: 'Contract documents', th: 'เอกสารสัญญา' },
  '选择本地知识库资料文件夹': { en: 'Choose a local knowledge folder', th: 'เลือกโฟลเดอร์ฐานความรู้ในเครื่อง' },
  '导出合同草稿并加入工作台（新文件）': { en: 'Export draft and add to workbench (new file)', th: 'ส่งออกฉบับร่างและเพิ่มในพื้นที่ทำงาน (ไฟล์ใหม่)' },
  'Word 合同草稿': { en: 'Word contract draft', th: 'ฉบับร่างสัญญา Word' },
  '导出修改稿和修改清单（新文件）': { en: 'Export revised contract and change list (new file)', th: 'ส่งออกสัญญาฉบับแก้ไขและรายการแก้ไข (ไฟล์ใหม่)' },
  'Word 修改稿': { en: 'Word revised contract', th: 'สัญญาฉบับแก้ไข Word' },
  '导出基础审核报告': { en: 'Export basic review report', th: 'ส่งออกรายงานการตรวจสอบพื้นฐาน' },
  'Markdown 审核报告': { en: 'Markdown review report', th: 'รายงานการตรวจสอบ Markdown' },
  '导入该合同的下一版本（保留原件）': { en: 'Import next contract version (keep original)', th: 'นำเข้าสัญญาเวอร์ชันถัดไป (เก็บต้นฉบับ)' },
  '选择共享盘或挂载目录': { en: 'Choose shared drive or mounted folder', th: 'เลือกไดรฟ์ที่ใช้ร่วมกันหรือโฟลเดอร์ที่เมานต์' },
  '导出报告': { en: 'Export report', th: 'ส่งออกรายงาน' },
  '合同工作报告': { en: 'Contract-work-report', th: 'รายงานงานสัญญา' },
  '导出已确认合同': { en: 'Export confirmed contract', th: 'ส่งออกสัญญาที่ผ่านการยืนยัน' },
  'Word合同': { en: 'Word contract', th: 'สัญญา Word' },
  '导出并加入合同工作台': { en: 'Export and add to workbench', th: 'ส่งออกและเพิ่มในพื้นที่ทำงานสัญญา' },
  '选择备份目录': { en: 'Choose backup folder', th: 'เลือกโฟลเดอร์สำรองข้อมูล' },
  '选择备份保存位置': { en: 'Choose where to save backup', th: 'เลือกตำแหน่งบันทึกข้อมูลสำรอง' },
};
export function nativeInterfaceText(locale: InterfaceLanguage, source: string): string {
  return locale === 'zh' ? source : labels[source]?.[locale] ?? source;
}
