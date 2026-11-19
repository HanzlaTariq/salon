import 'package:flutter/material.dart';
import 'package:flutter_core/flutter_core.dart';

import 'reports_models.dart';

/// 7 / 30 / 90 day selector. Touch targets are 48 px high.
class RangeChips extends StatelessWidget {
  const RangeChips({super.key, required this.selectedDays, required this.onSelected});

  final int selectedDays;
  final ValueChanged<int> onSelected;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: [
        for (final p in kReportPresets)
          ChoiceChip(
            label: Text(p.label),
            selected: p.days == selectedDays,
            materialTapTargetSize: MaterialTapTargetSize.padded,
            onSelected: (_) => onSelected(p.days),
          ),
      ],
    );
  }
}

/// A label with a big value and an optional hint, used in two-column grids.
class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.hint, this.valueColor});

  final String label;
  final String value;
  final String? hint;
  final Color? valueColor;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(label, style: t.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
            const SizedBox(height: AppSpacing.xs),
            FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(value, style: t.titleLarge?.copyWith(color: valueColor))),
            if (hint != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(hint!, style: t.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
          ],
        ),
      ),
    );
  }
}

/// Two tiles per row on phones, never overflowing.
class StatGrid extends StatelessWidget {
  const StatGrid({super.key, required this.tiles});

  final List<Widget> tiles;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final w = (c.maxWidth - AppSpacing.sm) / 2;
      return Wrap(spacing: AppSpacing.sm, runSpacing: AppSpacing.sm, children: [for (final t in tiles) SizedBox(width: w, child: t)]);
    });
  }
}

/// Bars of a trend (heights only; the exact values are in the semantics label of each bar).
class MiniBars extends StatelessWidget {
  const MiniBars({super.key, required this.title, required this.values, required this.labels, required this.valueTexts, this.color = AppColors.gold});

  final String title;
  final List<double> values;
  final List<String> labels;
  final List<String> valueTexts;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final max = values.fold<double>(1, (m, v) => v > m ? v : m);
    final t = Theme.of(context).textTheme.bodySmall;
    return Semantics(
      container: true,
      label: title,
      child: SizedBox(
        height: 140,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: values.length,
          separatorBuilder: (_, __) => const SizedBox(width: 6),
          itemBuilder: (context, i) {
            final h = values[i] <= 0 ? 2.0 : (values[i] / max * 100).clamp(2.0, 100.0);
            return Semantics(
              label: '${labels[i]}: ${valueTexts[i]}',
              child: SizedBox(
                width: 28,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    Container(height: h, decoration: BoxDecoration(color: values[i] <= 0 ? color.withValues(alpha: 0.2) : color, borderRadius: const BorderRadius.vertical(top: Radius.circular(4)))),
                    const SizedBox(height: 4),
                    Text(labels[i], style: t?.copyWith(fontSize: 9), maxLines: 1, overflow: TextOverflow.clip),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
