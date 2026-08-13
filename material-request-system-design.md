# ออกแบบระบบ Material Requirement & Call-in
### (Feature ใหม่บน Material Stock Web App เดิม)

---

## 1. Background

ฝ่ายผลิต request material สัปดาห์ละ 1 ครั้งผ่าน email ไปยัง WH โดยใช้ไฟล์ Excel ที่ทำงานดังนี้:

1. ใส่ Production Daily Output Plan
2. Cell คำนวณความต้องการ material อัตโนมัติ
3. ทีมกรอกแผนการเรียกเข้า (call-in) รายวัน Mon–Fri ต่อ material แต่ละตัว

---

## 2. ปัญหาที่พบ (Pain Points)

| # | ปัญหา | ผลกระทบ |
|---|-------|----------|
| 1 | เปลี่ยนเดือน แผนผลิตเปลี่ยน แต่คนลืมอัปเดต | คำนวณ requirement ผิดจากแผนเก่าโดยไม่รู้ตัว |
| 2 | แผนผลิตเปลี่ยนกลางสัปดาห์ | กระทบการใช้ material แต่ไฟล์ Excel ไม่รองรับการเปลี่ยนบางส่วน |
| 3 | Material บางตัวใช้ได้เฉพาะบาง product | Daily Output ต้องแยกตาม product ไม่ใช่ยอดรวม ไม่งั้นคำนวณผิด |

## 3. เงื่อนไขเพิ่มเติม

- มี **Material Stock Web App + Database** อยู่แล้ว → ระบบนี้ต้องเป็น **feature ใหม่** ที่ผนวกเข้าไป ไม่ใช่ระบบแยก

---

## 4. แนวคิดหลักในการออกแบบ

ปัญหาทั้ง 3 ข้อเกิดจากการที่ Excel เก็บข้อมูลแบบ **"ตัวเลขก้อนเดียวที่ถูกเขียนทับ"** (ไม่มี versioning, ไม่แยกตาม product)

**แนวทางแก้:** เปลี่ยนทุกอย่างให้เป็น **ข้อมูลที่มีวันที่กำกับ (dated / effective-dated records)** แทนการเขียนทับค่าเดิม

---

## 5. โครงสร้างข้อมูล (Data Model)

### 5.1 Product
```
product_id, product_name, product_type
```

### 5.2 Material
```
material_id, material_name, unit, safety_stock, current_stock   -- ดึงจาก stock DB เดิม
```

### 5.3 BOM (Bill of Material) — แก้ปัญหาข้อ 3
```
product_id, material_id, usage_rate_per_unit
```
ตารางนี้เป็นตัวกรองว่า material ไหนเกี่ยวข้องกับ product ไหน ตั้งค่าไว้ล่วงหน้าครั้งเดียว แก้ไขได้เมื่อสูตรเปลี่ยน

### 5.4 ProductionPlan — แก้ปัญหาข้อ 1 และ 2
```
plan_id, product_id, plan_date, planned_qty,
version, effective_from, created_by, created_at
```
ไม่ใช่ cell เดียวที่เขียนทับ แต่เป็น record ต่อ (product, วัน) เมื่อแก้แผนจะสร้าง **version ใหม่** ที่มี `effective_from` แทนการลบของเก่า ทำให้:
- แก้แผนกลางสัปดาห์ได้ → กระทบเฉพาะวันที่ยังไม่ถึง
- มี audit trail ว่าใครแก้ แก้เมื่อไร แก้จากอะไรเป็นอะไร

### 5.5 MaterialRequirement (คำนวณอัตโนมัติ ไม่ต้อง input)
```
required_qty(date, material) = Σ [planned_qty(product, date) × usage_rate(product, material)]
```
เป็น query/view ที่คำนวณสดจาก ProductionPlan × BOM เสมอ ไม่มีการ hardcode

### 5.6 MaterialCallIn
```
material_id, call_date, planned_call_qty, actual_received_qty, status
```
ส่วนที่ทีมยังต้อง input เอง (เรียกเข้าวันไหนเท่าไร) โดยระบบช่วย suggest ตัวเลขให้

---

## 6. ฟีเจอร์ที่แก้ปัญหาแต่ละข้อ

### 6.1 ลืมเปลี่ยนแผนตอนขึ้นเดือนใหม่
- Auto-reminder (email / in-app) ล่วงหน้า 3–5 วันก่อนสิ้นเดือน ให้กรอกแผนเดือนถัดไป
- ถ้าถึงวันที่ 1 ของเดือนใหม่แล้วยังไม่มี plan record สำหรับช่วงนั้น → ขึ้น warning banner แดงบน dashboard ทันที ไม่คำนวณเงียบ ๆ ด้วยแผนเก่า
- แสดง "แผนปัจจุบันมีผลถึงวันที่ X" ให้เห็นชัดตลอดเวลา

### 6.2 แผนเปลี่ยนกลางสัปดาห์
- ใช้ effective-dated versioning แทนการเขียนทับตัวเลขเดิม
- แก้แผนวันไหน กระทบการคำนวณเฉพาะวันนั้นเป็นต้นไปอัตโนมัติ วันที่ผ่านไปแล้วค่าคงเดิม (เพื่อ audit)
- แสดง diff ว่าตัวเลขเปลี่ยนจากอะไรเป็นอะไร ผลกระทบต่อ requirement ที่เหลือของสัปดาห์
- แจ้งเตือนทีม WH อัตโนมัติเมื่อ requirement เปลี่ยนเกิน threshold ที่ตั้งไว้ (เช่น >10%)

### 6.3 Material ใช้ไม่ได้กับทุก product
- หน้ากรอกแผนเป็นตารางแยกแถวตาม product × วัน ไม่ใช่ยอดรวมก้อนเดียว
- BOM เป็นตัวกำหนดว่า material ไหนเกี่ยวกับ product ไหน
- การคำนวณ requirement ต่อ material จะ sum เฉพาะ product ที่มี mapping กับ material นั้นเท่านั้น

---

## 7. เชื่อมกับ Web App เดิม (Stock DB)

Feature นี้ควร **join กับตาราง stock เดิมโดยตรง** ไม่ต้อง export/import ข้อมูล:

- **Requirement vs Stock check**: เทียบ `current_stock` กับ requirement สดทุกครั้ง แสดง `stock − requirement` รายวัน ติดลบ = highlight แดงว่าจะขาด
- **Suggested call-in qty**: pre-fill ตัวเลขแนะนำ = (requirement สะสมถึงวันนั้น) − (stock ปัจจุบัน) − (call-in ที่ตั้งไว้แล้ว) ให้ทีมปรับแก้แทนการคิดเลขเอง
- **Auto-generate weekly email to WH**: ปุ่มเดียวสร้างสรุป (requirement สัปดาห์หน้าต่อ material, current stock, call-in schedule Mon–Fri) เป็น email/PDF พร้อมส่ง

---

## 8. ลำดับการพัฒนาที่แนะนำ

1. สร้างตาราง Product, Material, **BOM** ก่อน (ฐานของทุกอย่าง ทำครั้งเดียว)
2. ปรับหน้ากรอก Production Plan ให้เป็นแบบ per-product + versioning
3. เขียน query คำนวณ Material Requirement แบบ real-time
4. เชื่อมกับ stock DB เดิม เพื่อโชว์ gap และ suggest call-in
5. เพิ่ม notification/reminder เป็นลำดับสุดท้าย (layer เสริม ไม่ใช่ core logic)

---

## 9. งานถัดไปที่ทำได้เพิ่มเติม

- ออกแบบหน้าตา UI ของหน้ากรอกแผน (mockup)
- เขียน SQL schema จริงสำหรับ implement
- Workflow diagram แบบภาพ (end-to-end)
