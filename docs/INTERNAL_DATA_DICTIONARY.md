# 内部数据接入字段清单

这个文档定义采购/备货模型需要的内部数据。首次接入时只需要导出字段，不需要一次性导入全部历史资料。

## 1. 销售出库数据

用途：预测未来需求，判断哪些SKU会消耗哪些原材料。

建议周期：最近 12-24 个月。

必需字段：

| 字段 | 说明 |
| --- | --- |
| order_date | 订单日期或出库日期 |
| sku | 产品SKU |
| product_name | 产品名称 |
| quantity | 销售/出库数量 |
| customer_type | 客户类型，如国内、电商、外贸、渠道 |
| sales_channel | 销售渠道 |
| unit_price | 销售单价，可选 |
| currency | 币种 |
| order_status | 订单状态 |

## 2. 成品与原材料库存

用途：计算库存可撑天数、缺货风险、备货量。

建议频率：每日快照。

必需字段：

| 字段 | 说明 |
| --- | --- |
| snapshot_date | 库存日期 |
| item_code | 物料/成品编码 |
| item_name | 名称 |
| item_type | 原材料、半成品、成品 |
| warehouse | 仓库 |
| available_qty | 可用库存 |
| locked_qty | 已锁定数量 |
| inbound_qty | 在途数量 |
| unit | 单位 |

## 3. BOM明细

用途：把原材料价格变化映射到产品成本。

必需字段：

| 字段 | 说明 |
| --- | --- |
| sku | 产品SKU |
| product_name | 产品名称 |
| bom_version | BOM版本 |
| material_code | 物料编码 |
| material_name | 物料名称 |
| material_spec | 规格型号 |
| qty_per_unit | 单台用量 |
| unit | 单位 |
| loss_rate | 损耗率 |
| standard_price | 标准单价或最近采购价 |
| supplier_code | 主供应商编码 |
| commodity_id | 对应行情指标 |

## 4. 采购历史

用途：判断供应商报价与行情偏离，计算真实采购价格趋势。

建议周期：最近 12-24 个月。

必需字段：

| 字段 | 说明 |
| --- | --- |
| po_date | 下单日期 |
| receipt_date | 入库日期 |
| material_code | 物料编码 |
| material_name | 物料名称 |
| supplier_code | 供应商编码 |
| supplier_name | 供应商名称 |
| quantity | 采购数量 |
| unit_price | 采购单价 |
| currency | 币种 |
| tax_rate | 税率 |
| unit | 单位 |
| po_status | 采购单状态 |

## 5. 供应商资料

用途：把采购建议变成可执行动作。

必需字段：

| 字段 | 说明 |
| --- | --- |
| supplier_code | 供应商编码 |
| supplier_name | 供应商名称 |
| material_code | 供货物料编码 |
| moq | 最小起订量 |
| lead_time_days | 常规交期 |
| payment_terms | 账期 |
| price_valid_days | 报价有效期 |
| can_lock_price | 是否可锁价 |
| quality_level | 品质等级或合格率 |
| on_time_rate | 准交率 |
| backup_supplier | 是否备选供应商 |

## 6. 生产计划

用途：当销售订单不完整时，用生产计划补足物料需求。

必需字段：

| 字段 | 说明 |
| --- | --- |
| plan_date | 计划日期 |
| sku | 产品SKU |
| planned_qty | 计划生产数量 |
| production_line | 产线 |
| plan_status | 计划状态 |

## 7. 物料与行情映射

用途：把内部物料绑定到公开行情或代理指标。

必需字段：

| 字段 | 说明 |
| --- | --- |
| material_code | 内部物料编码 |
| material_name | 内部物料名称 |
| commodity_id | 行情指标ID |
| commodity_name | 行情指标名称 |
| mapping_type | 真实行情、代理指标、供应商报价 |
| sensitivity | 敏感度，0-1 |
| note | 说明 |

## 8. 首次接入优先级

第一批建议只接：

1. 主销SKU的BOM。
2. 主销SKU近12个月销售/出库。
3. 核心原材料当前库存。
4. 核心原材料近12个月采购价。
5. 核心供应商交期、MOQ、账期。

优先级最高的物料：

- 电芯/电池包相关材料
- PCB/PCBA相关材料
- 铜线/硅胶线/启动夹
- 充气泵电机与结构件
- ABS/PC外壳料
- 纸箱和彩盒

